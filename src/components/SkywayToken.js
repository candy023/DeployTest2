import { SkyWayAuthToken } from '@skyway-sdk/token';
import { uuidV4, nowInSec } from '@skyway-sdk/room';

export default function GetToken(app_id, secret) { 
    return new SkyWayAuthToken({
        jti: uuidV4(),
        iat: nowInSec(),
        exp: nowInSec() + 60 * 60 * 24,
        scope: {
        app: {
            id: app_id,
            turn: true,
            actions: ['read'],
            channels: [
            {
                id: '*',
                name: '*',
                actions: ['write'],
                members: [
                {
                    id: '*',
                    name: '*',
                    actions: ['write'],
                    publication: {
                    actions: ['write'],
                    },
                    subscription: {
                    actions: ['write'],
                    },
                },
                ],
                sfuBots: [
                {
                    actions: ['write'],
                    forwardings: [
                    {
                        actions: ['write'],
                    },
                    ],
                },
                ],
            },
            ],
        },
        },
    }).encode(secret);
}