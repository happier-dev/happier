import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

const input = { selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } as const;

function publishPreference(token: string, enabled: boolean) {
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ managedMachineCreationEnabled: enabled }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    return createActionSettingsProvider({ scopeKey });
}

describe('managed creation preference at CLI Action origination', () => {
    afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

    it.each(['api_token', 'stored_session'] as const)('refuses opted-out %s acquisition before the existing public transport shortcut', async provenance => {
        const token = provenance === 'api_token'
            ? `hap_v1_00000000-0000-4000-8000-000000000001_${'a'.repeat(43)}`
            : `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
        const actionsSettingsProvider = publishPreference(token, false);
        // HTTP is the forwarding boundary; credential scopes and both Action
        // factories remain real. A disabled preference must not reach it.
        const post = vi.spyOn(axios, 'post');
        const get = vi.spyOn(axios, 'get');
        const fetch = vi.spyOn(globalThis, 'fetch');
        const executor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null,
            credentialProvenance: provenance }, actionsSettingsProvider, externalActionClient: true });
        expect(await executor.execute('machines.managed.acquire', input, { surface: 'cli' }))
            .toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
        expect(await executor.prepare('machines.managed.acquire', input, { surface: 'cli' }))
            .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'creation_disabled' } });
        expect(post).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses only the originating credential scope and never the receiving controller preference', async () => {
        const originToken = 'origin-account-token';
        publishPreference('different-account-token', false);
        const outputs: string[] = [];
        const harness = createCliActionExecutorHarness({ token: originToken, sessionId: '', mode: 'plain', ctx: null }, {
            // Durable Machine admission is the substituted transport boundary.
            managedMachineAction: async ({ actionId }) => { outputs.push(actionId); return { managedId: 'managed' }; },
        });
        const confirmation = { actionId: 'machines.managed.acquire' as const };
        expect(await harness.executor.execute('machines.managed.acquire', input,
            { surface: 'cli', authority: 'present_user', presentUserConfirmation: confirmation })).toMatchObject({ ok: true });
        publishPreference(originToken, false);
        expect(await harness.executor.execute('machines.managed.acquire', input,
            { surface: 'cli', authority: 'present_user', presentUserConfirmation: confirmation }))
            .toMatchObject({ ok: false, errorCode: 'creation_disabled' });
        expect(await harness.executor.execute('machines.managed.acquire', input,
            { surface: 'rpc', authority: 'present_user', runtimeAccountId: 'foreign-requester', presentUserConfirmation: confirmation }))
            .toMatchObject({ ok: true });
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'already-admitted-origin-proof', binding: {
            accountId: 'foreign-requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'srv_home',
            machineId: 'controller', custodianAccountId: 'controller-account', installationId: 'installation',
            actionId: 'machines.managed.acquire', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target,
        } });
        expect(await harness.executor.execute('machines.managed.acquire', input, { surface: 'ui', authority: 'present_user',
            runtimeAccountId: 'foreign-requester', externalActionExecutionAuthorization: authorization,
            externalActionTarget: target, presentUserConfirmation: confirmation })).toMatchObject({ ok: true });
        expect(outputs).toEqual(['machines.managed.acquire', 'machines.managed.acquire', 'machines.managed.acquire']);
    });
});
