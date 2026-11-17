import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';

const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
const params = { token, credentials: { token, encryption: null }, sessionId: 'cli-global',
    mode: 'plain' as const, ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test' };

afterEach(() => vi.restoreAllMocks());

describe('Friends Actions through requester CLI composition', () => {
    it.each(['agent', 'mcp', 'cli'] as const)('reaches both existing server writers on %s', async surface => {
        const user = { id: 'friend', firstName: 'Ada', lastName: null, username: 'ada', avatar: null,
            bio: null, publicKey: null, status: 'friend' };
        const requests: { path: string; body: unknown }[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.url === 'https://home.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (config.url === `https://home.test${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`) {
                expect(config.method).toBe('GET');
                return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
            }
            requests.push({ path: config.url ?? '', body: config.data });
            return { status: 200, data: { user: { ...user, status: config.url?.endsWith('/remove') ? 'none' : 'friend' } } };
        });
        const owner = createCliActionExecutor({ ...params, accountServerActionDeps: createAccountServerActionDeps(params),
            actionsSettingsProvider: { getAccountSettings: () => null,
                getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                    'friends.add': [surface], 'friends.remove': [surface],
                } }) } });
        for (const actionId of ['friends.add', 'friends.remove'] as const) {
            expect(await owner.execute(actionId, { uid: user.id }, { surface, authority: 'account_automation' }))
                .toMatchObject({ ok: true, result: { user: { id: user.id, status: actionId === 'friends.add' ? 'friend' : 'none' } } });
        }
        expect(requests).toEqual([
            { path: 'https://home.test/v1/friends/add', body: { uid: user.id } },
            { path: 'https://home.test/v1/friends/remove', body: { uid: user.id } },
        ]);
    });
});
