import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('paired terminal Session creation admission', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it.each([
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null },
        { outerTarget: true, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null },
        { outerTarget: false, daemonAccountId: 'different-account', terminalPolicy: 'allowed', authority: undefined, errorCode: 'target_unavailable' },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: 'account_automation', errorCode: 'invalid_parameters' },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'disallowed', authority: undefined, errorCode: 'invalid_parameters' },
    ] as const)('preserves exact Home/Account and terminal policy ($outerTarget/$daemonAccountId/$terminalPolicy/$authority)', async ({ outerTarget, daemonAccountId, terminalPolicy, authority, errorCode }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-create-admission-',
            env: { HAPPIER_CLI_PRESENT_USER: terminalPolicy } }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: daemonAccountId });
            const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'terminal-create',
                executionTarget: { serverId, machineId: 'own-machine' }, directory: { kind: 'managed' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
            // HTTP and persisted daemon publication are the system boundaries;
            // credential provenance, target resolution and both Action factories are real.
            vi.spyOn(axios, 'get').mockImplementation(async (url) => {
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (url.endsWith('/v1/machines/own-machine')) return { status: 200, data: { machine: {
                    id: 'own-machine', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                    dataEncryptionKey: null, runnerContentKeyBinding: null } } };
                throw new Error(`Unexpected HTTP read: ${url}`);
            });
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('Session creation is not a terminal Home finite Action'));
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId: 'session.spawn_new', input });
                // Mirror the existing receiver: an automation ceiling has no
                // bare terminal creation namespace and must not become human.
                if (new Headers(options.headers).get(AUTHORITY_CEILING_HEADER_V1) === 'account_automation') {
                    return Response.json({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
                }
                return Response.json({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                ...(outerTarget ? { machineId: 'own-machine' } : {}),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = await executor.execute('session.spawn_new', input, { surface: 'cli', ...(authority ? { authority } : {}) });
            expect(result).toEqual(errorCode === null
                ? { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } }
                : { ok: false, errorCode, error: errorCode });
        });
    });
});
