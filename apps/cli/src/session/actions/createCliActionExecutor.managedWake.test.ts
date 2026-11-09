import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['denied', 'transport', 'malformed', 'cancelled'] as const)(
    'keeps canonical CLI control denial distinct from a failed power review read, read=%s', async read => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester', provenance: {
        v: 1, kind: 'account', authority: 'present_user',
    } })).toString('base64url')}.signature`;
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1 } }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    let admissions = 0;
    const cancellation = new AbortController();
    const nativeRequests: string[] = [];
    // HTTP status/body and network failure are boundaries; normalization and default preparation remain real.
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (path === '/v1/machines/managed/actions/get') {
            if (read === 'denied') return { status: 403, data: { code: 'permission_denied' } };
            if (read === 'transport') throw new axios.AxiosError('Review transport unavailable', 'ECONNREFUSED');
            if (read === 'cancelled') {
                cancellation.abort();
                throw new axios.CanceledError('Review cancelled');
            }
            return { status: 200, data: { invalid: 'not a managed row' } };
        }
        if (path.endsWith('/admit-control')) {
            admissions++;
            return { status: 403, data: { code: 'managed_power_required' } };
        }
        nativeRequests.push(path);
        throw new Error(`Unexpected native request ${path}`);
    });
    const credentials = { token, encryption: null };
    const account = createAccountServerActionDeps({ token, credentials, serverId: 'srv_power_read',
        serverIdentityId: 'srv_power_read', serverHttpBaseUrl: 'https://power-read.test' });
    const harness = createCliActionExecutorHarness({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId: 'srv_power_read', serverIdentityId: 'srv_power_read', serverHttpBaseUrl: 'https://power-read.test',
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
    }, { managedMachineAction: account.managedMachineAction });
    const execution = harness.executor.execute('machines.managed.power.set', {
        homeId: 'srv_power_read', managedId: 'foreign-managed', expectedRevision: 4, when: 'now', intent: 'stop',
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'requester',
        serverId: 'srv_power_read', actionRequestId: `power-read-${read}`, signal: cancellation.signal,
        presentUserConfirmation: { actionId: 'machines.managed.power.set' } });
    if (read === 'malformed') await expect(execution).rejects.toThrow();
    else expect(await execution).toMatchObject({ ok: false,
        errorCode: read === 'denied' ? 'managed_power_required' : read === 'cancelled' ? 'cancelled' : 'server_unreachable' });
    expect(admissions).toBe(read === 'denied' ? 1 : 0);
    expect(nativeRequests).toEqual([]);
});

it.each(['asleep', 'running', 'manual', 'local', 'passive', 'waived', 'profile-alias'] as const)(
    'prepares an agent %s target through default CLI admission with exact reads and no effects', async mode => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', provenance: {
        v: 1, kind: 'account', authority: 'present_user',
    } })).toString('base64url')}.signature`;
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    const settings = mode === 'waived' ? setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
        actionId: 'machines.managed.power.set', surface: 'agent', approvalRequired: false }) : ActionsSettingsV1Schema.parse({ v: 1 });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: settings }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const machine = ManagedMachineV1Schema.parse({ id: 'managed-guest', homeId: 'srv_wake_admission', custodianAccountId: 'owner',
        controller: { machineId: 'controller', installationId: 'installation' },
        enrolledMachineId: 'guest', allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
        launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { availability: 'present', power: mode === 'running' || mode === 'profile-alias' ? 'running' : 'stopped', storage: 'retained', observedAt: 1 },
    });
    const queries: unknown[] = [];
    // Account HTTP, approval persistence and filesystem execution are system boundaries.
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(request.url).toBe('https://wake-admission.test/v1/machines/managed/actions/list');
        queries.push(request.data);
        return { status: 200, data: { machines: mode === 'manual' ? [] : [machine] } };
    });
    let reviews = 0;
    let effects = 0;
    const credentials = { token, encryption: null };
    const serverId = mode === 'profile-alias' ? 'stack_wake_admission' : 'srv_wake_admission';
    const account = createAccountServerActionDeps({ token, credentials, serverId,
        serverIdentityId: 'srv_wake_admission', serverHttpBaseUrl: 'https://wake-admission.test' });
    const harness = createCliActionExecutorHarness({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId,
        serverIdentityId: 'srv_wake_admission', serverHttpBaseUrl: 'https://wake-admission.test',
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
    }, { managedMachineAction: account.managedMachineAction,
        approvalsCreate: async () => { reviews++; return { artifactId: 'original-read-approval' }; },
        filesystemActionExecute: async () => { effects++; return { success: true, content: '' }; },
    });
    const prepared = await harness.executor.prepare(mode === 'passive' ? 'daemon.filesystem.listDirectory' : 'daemon.filesystem.readFile', { rootPath: '/workspace', path: 'README.md' }, {
        surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, runtimeAccountId: 'owner',
        serverId, actionRequestId: 'original-read',
        ...(mode === 'local' ? { defaultSessionMachineId: 'guest' } : { externalActionTarget: { kind: 'machine' as const, machineId: 'guest' } }),
    });
    expect(prepared, JSON.stringify(prepared)).toMatchObject(mode === 'asleep' ? { kind: 'settled', result: { ok: true,
        result: { kind: 'approval_request_created', artifactId: 'original-read-approval' } } } : { kind: 'ready' });
    expect(queries).toEqual(mode === 'passive' || mode === 'local' ? [] : [{ homeId: 'srv_wake_admission', enrolledMachineId: 'guest' }]);
    expect(reviews).toBe(mode === 'asleep' ? 1 : 0);
    expect(effects).toBe(0);
});
