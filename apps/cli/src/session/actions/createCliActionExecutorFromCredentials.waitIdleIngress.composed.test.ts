import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import type { SessionMessagePageActivityV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const network = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: network.io }));

describe('original CLI wait for an owned Session on another Account’s Machine', () => {
    afterEach(() => { vi.restoreAllMocks(); network.io.mockReset(); });

    it('observes idle with Session access without requiring publisher Machine admission', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-wait-idle-ingress-' }, async () => {
            // HTTP/socket boundary credentials represent the Session owner, not its Machine custodian.
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            // Same exact input as the cut39 native refusal; the completed activity comes from its read control.
            const sessionId = 'cmwu7grus00bljmm69uwz0bdg';
            const activity = { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
                latestTurnStatus: 'completed' } satisfies SessionMessagePageActivityV1;
            const session = createSessionRecordFixture({ id: sessionId, accountId: 'requester',
                machineId: 'custodian-machine', active: false, encryptionMode: 'plain',
                metadataLayoutVersion: 1, metadata: '{}', share: null,
                ownerMetadata: { t: 'plain', v: { v: 1, machineId: 'custodian-machine' } }, ...activity });
            vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
                expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.includes(`/v1/sessions/${sessionId}/messages`)) return { status: 200,
                    data: { messages: [], hasMore: false, activity } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
                    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            const machineAdmission = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected Machine admission'));
            network.io.mockImplementation(() => createApiSessionSocketStub({ connected: true }));
            const executor = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                resolveServerFeaturesSnapshot: () => undefined,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const input = { sessionId };
            const result = await executor.execute('session.wait.idle', input,
                bindPresentUserActionConfirmationV1('session.wait.idle', input, {
                    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                }));
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, sessionId, idle: true, observedAt: expect.any(Number) } });
            expect(machineAdmission).not.toHaveBeenCalled();
        });
    });
});
