import axios from 'axios';
import nacl from 'tweetnacl';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ApiMachineClient } from '@/api/apiMachine';
import { configuration } from '@/configuration';
import { readAccountChangesCursor, updateSettings } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ChangeEntrySchema, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, type ChangeEntry } from '@happier-dev/protocol/changes';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ManagedPolicyAdmissionInputV1Schema, ManagedPolicyCensusInputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { logger } from '@/ui/logger';
import { createManagedGuestActivityTransport } from '@/machines/managed/managedActivityTransport';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { commitActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

// Only the socket transport is substituted. Real RPC decoding produces the
// RpcError consumed by the acquisition driver, adapter and operation store.
const wire = vi.hoisted(() => ({ reads: 0, publications: [] as string[], refusal: 'RPC_FORBIDDEN',
    busyGuest: false, updates: new Set<(...args: unknown[]) => void>(),
    heldRead: undefined as (() => void) | undefined, holdGuestRead: false,
    releaseGuestRead: undefined as (() => void) | undefined }));
vi.mock('socket.io-client', async () => {
    const { createSocketIoManagerStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    const { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
        MachineUpdateOperationProtocolCapabilitiesRequestV1Schema } = await import('@happier-dev/protocol/machines/operationProtocolCapabilitiesV1');
    return { io: () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket = { connected: false, io: createSocketIoManagerStub(), emit() {},
        on(event: string, listener: (...args: unknown[]) => void) {
            if (event === 'update') wire.updates.add(listener);
            const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); return socket;
        },
        off(event: string, listener: (...args: unknown[]) => void) {
            if (event === 'update') wire.updates.delete(listener);
            listeners.get(event)?.delete(listener); return socket;
        },
        connect() { socket.connected = true; for (const listener of listeners.get('connect') ?? []) listener(); },
        disconnect() { socket.connected = false; }, close() { socket.connected = false; },
        removeAllListeners() {
            for (const listener of listeners.get('update') ?? []) wire.updates.delete(listener);
            listeners.clear();
        }, offAny() {},
        async emitWithAck(event: string, input: { method?: string; daemonState?: string; expectedVersion?: number }) {
            if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
                MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(input);
                return { v: 1, result: 'success', revision: 1 };
            }
            if (event === 'machine-update-state') {
                wire.publications.push(input.daemonState!);
                return { result: 'success', version: input.expectedVersion! + 1, daemonState: input.daemonState };
            }
            if (input.method === 'guest:managed.activity.read' || input.method === 'incumbent-guest:managed.activity.read') {
                wire.reads += 1;
                if (wire.busyGuest) return { ok: true, result: { kind: 'busy', reasons: ['finite'] } };
                if (input.method === 'incumbent-guest:managed.activity.read') {
                    await new Promise<void>(resolve => { wire.heldRead = resolve; });
                }
                if (input.method === 'guest:managed.activity.read' && wire.holdGuestRead) {
                    await new Promise<void>(resolve => { wire.releaseGuestRead = resolve; });
                }
                // An actual asynchronous refusal: the operation is published
                // and waiting before the Home acknowledgement arrives.
                await new Promise<void>(resolve => setImmediate(resolve));
                return { ok: false, error: 'Refused by Home', errorCode: wire.refusal };
            }
            throw new Error(`Unexpected socket boundary: ${event} ${input.method}`);
        },
    };
    return socket;
} };
});

afterEach(() => vi.restoreAllMocks());

it('wakes a requester guest activity wait only from its exact existing managed-row feed', async () => {
    wire.busyGuest = true; wire.reads = 0; wire.updates.clear();
    const machine = ManagedMachineV1Schema.parse({ id: 'activity-managed', homeId: 'home', custodianAccountId: 'owner',
        enrollmentAccountId: 'requester', controller: { machineId: 'controller', installationId: 'installation' },
        enrolledMachineId: 'guest', allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'unused', afterMs: 60_000, effect: 'stop' }, wakeOnAcceptedMessage: false });
    let changes: ChangeEntry[] = [];
    let cursor = 0;
    let consumedCursor = -1;
    const homeReads: string[] = [];
    // Complete the durable cursor owner's one-way import before observing feed delivery.
    expect(await readAccountChangesCursor('owner')).toBe(0);
    // A running daemon has already admitted its own Account snapshot. Team
    // feed changes also refresh unrelated Saved Secrets through their real owner.
    commitActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken('fixture-token') });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        homeReads.push(new URL(String(url)).pathname);
        if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: {
            id: 'owner', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [],
        } };
        if (String(url).includes('/v2/changes')) {
            consumedCursor = cursor;
            return { status: 200, data: { changes, nextCursor: cursor } };
        }
        if (String(url).endsWith('/v1/auth/ping')) return { status: 200, data: {} };
        if (String(url).endsWith('/v1/account/security')) return { status: 404, data: {} };
        if (String(url).endsWith('/v1/account/saved-secrets/resources/materials')) return { status: 404, data: {} };
        throw new Error(`No private guest read is allowed: ${url}`);
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const client = new ApiMachineClient('fixture-token', { id: 'controller', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    // This fixture owns no connected-service resources. Consume and assert the
    // real startup projection rather than bypassing the public connection flow.
    const unsubscribeProjection = client.onConnectedServicesProjection(notification => {
        expect(notification.connectedServicesV2).toEqual([]);
        expect(notification.connectedServiceCredentialRevisionsV1).toEqual([]);
    });
    const input = { token: 'fixture-token', serverUrl: 'https://activity-feed.example',
        credentials: { token: 'fixture-token', encryption: null },
        subscribeManagedMachineChanges: client.onManagedMachinePolicyInvalidated.bind(client) };
    const bridge = createManagedGuestActivityTransport(input, { requestId: 'retention' }, machine);
    const cancel = new AbortController();
    let waiting: Promise<unknown> | undefined;
    const wakes: Array<'activity' | 'currentness' | void> = [];
    const sync = async (managedId: string, withTeamChange = false) => {
        changes = [ChangeEntrySchema.parse({ kind: 'account', entityId: managedId, cursor: ++cursor, changedAt: 1,
            hint: { managedMachinePolicy: true, machineId: 'controller' } })];
        if (withTeamChange) changes.push(ChangeEntrySchema.parse({ kind: 'account',
            entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, cursor: ++cursor, changedAt: 1, hint: null }));
        for (const update of wire.updates) update({ id: 'activity-change', seq: cursor, createdAt: 1,
            body: { t: 'account-change' } });
        // Cursor acknowledgement follows classification and listener delivery.
        await vi.waitFor(async () => expect(await readAccountChangesCursor('owner')).toBe(cursor));
    };
    try {
        runWithServerHttpBaseUrl(input.serverUrl, () => client.connect());
        await vi.waitFor(() => expect(consumedCursor, JSON.stringify(homeReads)).toBe(0));
        expect(await bridge.read(machine)).toMatchObject({ kind: 'busy' });
        waiting = bridge.waitForChange(cancel.signal).then(result => { wakes.push(result); return result; });
        await sync('unrelated-managed-row');
        expect(wakes).toEqual([]);
        expect(wire.reads).toBe(1);
        await sync(machine.id, true);
        // A full reset includes the exact row's activity invalidation even
        // when the same page also changes Team authority.
        expect(await waiting).toBe('activity');
        expect(wakes).toEqual(['activity']);
        expect(await bridge.read(machine)).toMatchObject({ kind: 'busy' });
        expect(wire.reads).toBe(2);
    } finally {
        cancel.abort();
        await waiting?.catch(() => undefined);
        await bridge.dispose?.();
        await client.shutdown();
        unsubscribeProjection();
        resetActiveAccountSettingsSnapshotForTests();
    }
});

it.each(['unreachable', 'target-unavailable', 'method-unavailable', 'transport-unavailable', 'method-not-found', 'refusal', 'read-failure', 'read-abort', 'satisfied', 'replaced',
    'manual-stop', 'manual-suspend', 'manual-stop-held', 'manual-suspend-held', 'manual-delete-held', 'manual-stop-held-observed',
    'manual-stop-held-currentness'] as const)(
    'composes guest readiness and policy operation settlement (%s)', async scenario => {
    wire.reads = 0; wire.publications.length = 0; wire.heldRead = undefined; wire.releaseGuestRead = undefined;
    wire.busyGuest = scenario === 'manual-stop' || scenario === 'manual-suspend';
    wire.refusal = scenario === 'target-unavailable' ? 'target_unavailable'
        : scenario === 'method-unavailable' ? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        : scenario === 'transport-unavailable' ? RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE
        : scenario === 'method-not-found' ? RPC_ERROR_CODES.METHOD_NOT_FOUND : RPC_ERROR_CODES.FORBIDDEN;
    wire.updates.clear();
    wire.holdGuestRead = scenario === 'satisfied' || scenario === 'replaced' || scenario.includes('-held');
    const aborts = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0 })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const serverUrl = 'https://policy-readiness.example';
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
        [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Policy Home', serverUrl, webappUrl: serverUrl,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: serverUrl, revision: 1,
                endpoints: [{ kind: 'https', url: serverUrl }] } },
    } }));
    const signing = nacl.sign.keyPair();
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'owner',
        controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'unused', afterMs: 60_000, effect: scenario === 'refusal' ? 'delete' : 'stop' }, wakeOnAcceptedMessage: false });
    const incumbent = ManagedMachineV1Schema.parse({ ...machine, id: 'incumbent', enrolledMachineId: 'incumbent-guest' });
    const deadline = ManagedMachineV1Schema.parse({ ...machine, id: 'deadline', enrolledMachineId: undefined,
        retention: { kind: 'deadline', at: Date.now() - 1, effect: 'stop' } });
    const cleanup = ManagedMachineV1Schema.parse({ ...machine, id: 'cleanup', enrolledMachineId: undefined,
        creationState: 'canceled', desired: 'delete', allocation: 'may-exist', resource: undefined,
        nativeOperationRef: machine.resource, retention: { kind: 'until-delete' } });
    const rows = new Map([machine, incumbent, deadline, cleanup].map(row => [row.id, row]));
    let censusMachines = scenario === 'read-failure' ? [incumbent]
        : scenario === 'read-abort' ? [machine, deadline, cleanup] : [machine];
    let reachable = scenario !== 'unreachable';
    let unreadable = false;
    const readinessFailure = new Error('Exact guest publication unavailable');
    const readinessReads: string[] = [];
    const policyPreparations: string[] = [];
    const failures: unknown[] = [];
    let readinessPending = false;
    let registered = true;
    let changes: ChangeEntry[] = [];
    let cursor = 0;
    const rawMachine = (id: string) => ({ id, active: id === 'controller' || reachable,
        installationId: id === 'controller' ? 'installation' : 'guest-installation',
        metadata: null, metadataVersion: 0, daemonStateVersion: wire.publications.length,
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        daemonState: id === 'controller' ? wire.publications.at(-1) ?? encodePlainMachineStoredContent({ status: 'running' })
            : encodePlainMachineStoredContent({ status: registered ? 'running' : 'starting', startedAt: 1 }) });
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v2/changes') return { status: 200, data: { changes, nextCursor: cursor } };
        if (path.startsWith('/v1/machines/')) {
            if (path.endsWith('/guest')) expect(new URL(String(url)).origin).toBe(serverUrl);
            if (path.endsWith('/guest') || path.endsWith('/incumbent-guest')) readinessReads.push(path);
            if (unreadable && path.endsWith('/guest')) throw readinessFailure;
            if (scenario === 'read-abort' && path.endsWith('/guest')) {
                return await new Promise<never>((_resolve, reject) => {
                    const signal = options?.signal;
                    if (!(signal instanceof AbortSignal)) throw new Error('Missing readiness cancellation signal');
                    const abort = () => reject(signal.reason);
                    signal.addEventListener('abort', abort, { once: true });
                    readinessPending = true;
                    if (signal.aborted) abort();
                });
            }
            return { status: 200, data: { machine: rawMachine(path.split('/').at(-1)!) } };
        }
        throw new Error(`Unexpected HTTP read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (String(url).endsWith('/controller/policies')) {
            const { managedId, managedIds } = ManagedPolicyCensusInputV1Schema.parse(body);
            const selectedIds = managedId ? [managedId] : managedIds;
            return { status: 200, data: { machines: selectedIds
                ? censusMachines.filter(machine => selectedIds.includes(machine.id)) : censusMachines, targets: [] } };
        }
        if (String(url).endsWith('/controller/prepare-policy')) {
            const request = ManagedPolicyAdmissionInputV1Schema.parse(body);
            policyPreparations.push(request.managedId);
            // The Home refuses native admission; no external effect is executed.
            return { status: 503, data: { error: 'admission_unavailable' } };
        }
        if (String(url).endsWith('/controller/report-policy-failure')) return { status: 200, data: {} };
        throw new Error(`Unexpected HTTP mutation: ${url}`);
    });
    const api = await ApiClient.create(credentials);
    const controller = (await api.getMachine('controller'))!;
    const client = new ApiMachineClient(token, controller, undefined, { loadMachine: options => api.getMachine('controller', options) });
    const transport = client as unknown as { socket: unknown; syncChangesOnConnect(options: { reason: 'live' }): Promise<void> };
    const { io } = await import('socket.io-client');
    const socket = io(); socket.connect(); transport.socket = socket;
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential IO'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    const native = nativeFixture({ privateNative: true });
    const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
    const activity = createManagedActivityInventory({ producers: [operations.activity] });
    const publications: Promise<unknown>[] = [];
    const unsubscribe = activity.subscribe(decision => {
        publications.push(client.updateDaemonState(state => ({ ...(state ?? { status: 'running' }), managedActivity: decision })));
    });
    const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller',
        serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
        installationIdentity: { installationId: 'installation', privateKey: signing.secretKey }, managedProviderOperationAuthority: authority,
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
            resolveCurrentMachineId: () => 'controller', resolveCurrentServerIdentityId: () => 'srv_home' }),
        acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
        observeActionExecution: request => operations.observeExecution(request), readPolicyCurrent: async id => rows.get(id) ?? null,
        executeManagedPolicyAction: unavailable });
    const runtime = createDaemonManagedMachinePolicyRuntime({ apiMachine: client,
        loadMachine: (id, signal) => runWithServerHttpBaseUrl(serverUrl, () => api.getMachine(id, { signal })),
        readCensus: (signal, managedIds) => readManagedMachinePolicyCensus({ homeId: 'srv_home', controller: machine.controller,
            custodianAccountId: 'owner', privateKey: signing.secretKey, token, serverUrl, signal, managedIds }),
        executePolicy: adapter.executePolicy, onUnavailable: error => { failures.push(error); } });
    const list = async () => ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items;
    const drain = () => new Promise<void>(resolve => setImmediate(resolve));
    const sync = async (machineId: string) => {
        changes = [ChangeEntrySchema.parse({ kind: 'machine', entityId: machineId, cursor: ++cursor, changedAt: Date.now(), hint: null })];
        await transport.syncChangesOnConnect({ reason: 'live' }); await drain();
    };
    try {
        await activity.read(); await Promise.all(publications);
        runtime.notifyChanged(); await drain();
        if (scenario === 'read-abort') {
            await vi.waitFor(() => expect(readinessPending).toBe(true));
            await runtime.stop();
            expect(failures).toEqual([]);
            expect(policyPreparations).toEqual([]);
            expect(await list()).toEqual([]);
            expect(wire.reads).toBe(0);
            return;
        }
        if (scenario === 'read-failure') {
            await vi.waitFor(() => expect(wire.heldRead).toBeTypeOf('function'));
            expect(await list()).toMatchObject([{ state: 'running', domainRef: { id: incumbent.id } }]);
            // A failing first guest must neither starve independent policy rows
            // nor prevent retirement of a lifetime omitted from this census.
            unreadable = true;
            censusMachines = [machine, deadline, cleanup];
            runtime.notifyChanged();
            await vi.waitFor(() => expect(failures).toContain(readinessFailure));
            await vi.waitFor(() => expect([...policyPreparations].sort()).toEqual(['cleanup', 'deadline']));
            await vi.waitFor(async () => expect(await list()).toHaveLength(3));
            await vi.waitFor(async () => expect((await list()).find(item => item.domainRef?.kind === 'managedMachine'
                && item.domainRef.id === incumbent.id)).toMatchObject({ state: 'cancelled' }));
            // One exact failed readiness read, no retries, inventory scan or
            // guest activity read for the unreadable row/deadline/cleanup.
            expect(readinessReads.filter(path => path === '/v1/machines/guest')).toHaveLength(1);
            expect(wire.reads).toBe(1);
            expect(failures).toEqual([readinessFailure]);
            return;
        }
        if (scenario === 'satisfied' || scenario === 'replaced') {
            await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'running',
                progress: { phase: 'managed.intent.waiting-idle' } }]));
            const original = (await list())[0]!;
            censusMachines = [ManagedMachineV1Schema.parse(scenario === 'satisfied'
                ? { ...machine, observation: { observedAt: 2, availability: 'present', power: 'suspended' } }
                : { ...machine, retention: { kind: 'unused', afterMs: 120_000, effect: 'stop' } })];
            runtime.notifyChanged();
            await vi.waitFor(() => expect(aborts).toHaveBeenCalledWith('[managed-policy.abort]', expect.objectContaining({
                managedId: machine.id, reasonCode: scenario === 'satisfied' ? 'retention_satisfied' : 'policy_replaced',
            })));
            wire.releaseGuestRead?.();
            await vi.waitFor(async () => expect((await list()).find(item => item.operationId === original.operationId))
                .toMatchObject({ state: scenario === 'satisfied' ? 'succeeded' : 'cancelled' }));
            expect(policyPreparations).toEqual([]);
            return;
        }
        if (scenario === 'target-unavailable' || scenario === 'method-unavailable' || scenario === 'transport-unavailable') {
            // The HTTP readiness publication can precede unavailable registration
            // or loss of the exact guest socket. This is not an idle decision
            // or a failed automatic operation.
            await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'running',
                progress: { phase: 'managed.intent.activity-unknown' } }]));
            const original = (await list())[0]!;
            expect(wire.reads).toBe(1);
            for (let index = 0; index < 60; index += 1) {
                for (const listener of wire.updates) listener({ id: `unrelated-account-${index}`, seq: index + 1, createdAt: 1,
                    body: { t: 'account-change' } });
                await drain();
            }
            expect(await list()).toMatchObject([{ operationId: original.operationId, state: 'running',
                progress: { phase: 'managed.intent.activity-unknown' } }]);
            expect(wire.reads).toBe(1);
            // managedMachinePolicyRuntime.ts keeps the outstanding native
            // lifetime: equal censuses must not re-read its admitted readiness.
            for (let index = 0; index < 32; index += 1) {
                runtime.notifyChanged();
                await drain();
            }
            expect(readinessReads.filter(path => path === '/v1/machines/guest')).toHaveLength(1);
            wire.busyGuest = true;
            for (const listener of wire.updates) listener({ id: 'guest-ready-again', seq: 61, createdAt: 1,
                body: { t: 'update-machine', machineId: machine.enrolledMachineId } });
            await vi.waitFor(async () => expect(await list()).toMatchObject([{
                operationId: original.operationId, state: 'running', progress: { phase: 'managed.intent.busy' },
            }]));
            expect(wire.reads).toBe(2);
            expect(readinessReads.filter(path => path === '/v1/machines/guest')).toHaveLength(1);
            console.info('managed-policy-read-counts', JSON.stringify({ initialReadiness: readinessReads.length,
                unchangedCensuses: 32, unrelatedArrivals: 60, initialActivity: 1, changedActivity: wire.reads }));
            expect(policyPreparations).toEqual([]);
            expect(failures).toEqual([]);
            return;
        }
        if (scenario.startsWith('manual-')) {
            if (wire.holdGuestRead) await vi.waitFor(() => expect(wire.releaseGuestRead).toBeTypeOf('function'));
            else await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'running',
                progress: { phase: 'managed.intent.busy' } }]));
            const original = (await list())[0]!;
            const originalReads = wire.reads;
            // The Home admits the person's intent and publishes its managed-row
            // invalidation before submit-intent records the native effect.
            let manual = ManagedMachineV1Schema.parse({ ...machine,
                desired: scenario.includes('delete') ? 'delete' : scenario.includes('suspend') ? 'suspend' : 'stop',
                ...(scenario === 'manual-stop-held-observed'
                    ? { observation: { observedAt: 2, availability: 'present', power: 'stopped' } } : {}),
                intentRevision: machine.intentRevision + 1 });
            rows.set(manual.id, manual); censusMachines = [manual];
            if (scenario === 'manual-stop-held-currentness') {
                // The RPC can fail before the scheduler receives its census.
                // The driver's exact currentness read must still retire it.
                wire.refusal = 'RPC_OUTCOME_UNKNOWN'; wire.releaseGuestRead?.();
            } else {
                changes = [ChangeEntrySchema.parse({ kind: 'account', entityId: manual.id, cursor: ++cursor,
                    changedAt: Date.now(), hint: { managedMachinePolicy: true, machineId: 'controller' } })];
                await transport.syncChangesOnConnect({ reason: 'live' }); await drain();
                if (wire.holdGuestRead) {
                    // Exercise the ordinary successful census while the guest
                    // ACK is held, before power-down releases a stale error.
                    runtime.notifyChanged(); await drain();
                    await vi.waitFor(async () => expect((await list()).find(item => item.operationId === original.operationId))
                        .toMatchObject({ state: 'cancelled' }));
                    wire.refusal = 'RPC_OUTCOME_UNKNOWN'; wire.releaseGuestRead?.();
                }
            }
            await vi.waitFor(async () => expect((await list()).find(item => item.operationId === original.operationId))
                .toMatchObject({ state: 'cancelled' }));
            wire.busyGuest = false; wire.refusal = 'RPC_OUTCOME_UNKNOWN';
            // Exercise the actual Account changes classifier for both the
            // admitted-row publication and guest presence/registration edges.
            for (let index = 0; index < 32; index += 1) {
                if (index === 8 || index === 16) {
                    manual = ManagedMachineV1Schema.parse({ ...manual, submittedNativeEffect: index === 8
                        ? { intentRevision: manual.intentRevision, requestId: 'manual-power', intent: manual.desired,
                            controller: manual.controller } : undefined });
                    rows.set(manual.id, manual); censusMachines = [manual];
                }
                if (index === 24) reachable = false;
                changes = [ChangeEntrySchema.parse({ kind: 'account', entityId: machine.id, cursor: ++cursor,
                    changedAt: Date.now(), hint: { managedMachinePolicy: true, machineId: 'controller' } })];
                await transport.syncChangesOnConnect({ reason: 'live' }); await drain();
                await sync('guest');
            }
            expect(await list()).toEqual([expect.objectContaining({ operationId: original.operationId, state: 'cancelled' })]);
            expect(wire.reads).toBe(originalReads);
            expect(policyPreparations).toEqual([]);
            expect(failures).toEqual([]);
            // Native Start can finish before the guest daemon returns. Keep
            // its old running publication while offline, then publish starting
            // while the new daemon registers its RPCs. Neither is readiness.
            let restarted = ManagedMachineV1Schema.parse({ ...manual, desired: 'start', intentRevision: manual.intentRevision + 1,
                observation: { observedAt: 2, availability: 'present', power: scenario === 'manual-stop' ? 'stopped' : 'suspended' },
                submittedNativeEffect: { intentRevision: manual.intentRevision + 1, requestId: 'manual-start', intent: 'start',
                    controller: manual.controller } });
            const expectDeferredStart = async () => {
                rows.set(restarted.id, restarted); censusMachines = [restarted];
                for (let index = 0; index < 8; index += 1) await sync('guest');
                expect(await list()).toEqual([expect.objectContaining({ operationId: original.operationId, state: 'cancelled' })]);
                expect(wire.reads).toBe(originalReads);
                expect(policyPreparations).toEqual([]);
                expect(failures).toEqual([]);
            };
            await expectDeferredStart();
            restarted = ManagedMachineV1Schema.parse({ ...restarted, submittedNativeEffect: undefined,
                observation: { observedAt: 3, availability: 'present', power: 'running' } });
            await expectDeferredStart();
            reachable = true; registered = false;
            await expectDeferredStart();
            registered = true; wire.busyGuest = true; wire.holdGuestRead = false;
            await sync('guest');
            await vi.waitFor(async () => expect(await list()).toHaveLength(2));
            await vi.waitFor(() => expect(wire.reads).toBe(originalReads + 1));
            for (let index = 0; index < 8; index += 1) await sync('guest');
            const resumedOperations = await list();
            expect(resumedOperations).toHaveLength(2);
            expect(resumedOperations.find(item => item.operationId === original.operationId)).toMatchObject({ state: 'cancelled' });
            expect(resumedOperations.find(item => item.operationId !== original.operationId)).toMatchObject({
                state: 'running', progress: { phase: 'managed.intent.busy' },
            });
            expect(wire.reads).toBe(originalReads + 1);
            expect(policyPreparations).toEqual([]);
            expect(failures).toEqual([]);
            return;
        }
        if (scenario === 'unreachable') {
            // Separate, settled invalidations cannot create guest work during enrollment.
            for (let i = 0; i < 32; i++) { runtime.notifyChanged(); await drain(); }
            expect(await list()).toHaveLength(0); expect(wire.reads).toBe(0);
            // A newly connected daemon has not registered its RPCs yet. Neither
            // presence alone nor a stale running state from an offline daemon suffices.
            reachable = true; registered = false;
            await sync('guest');
            expect(await list()).toHaveLength(0); expect(wire.reads).toBe(0);
            registered = true;
            await sync('guest');
        }
        await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'failed' }]));
        expect((await list())[0]).toMatchObject({ error: { errorCode: wire.refusal },
            progress: { phase: 'managed.intent.waiting-idle' } });
        expect(wire.reads).toBe(1);
        // Flush the real operation -> activity -> daemon-state -> Account
        // changes consumer after settlement, when the scheduler no longer holds it.
        for (let i = 0; i < 8; i++) { await Promise.all(publications); await sync('controller'); }
        expect(wire.publications.length).toBeGreaterThan(1);
        expect(await list()).toHaveLength(1); expect(wire.reads).toBe(1);
        // A real guest restart still wakes this exact retained policy.
        reachable = false; await sync('guest'); expect(await list()).toHaveLength(1);
        reachable = true; await sync('guest');
        await vi.waitFor(async () => expect(await list()).toHaveLength(2));
        await vi.waitFor(() => expect(wire.reads).toBe(2));
    } finally {
        wire.heldRead?.();
        wire.releaseGuestRead?.();
        await runtime.stop(); unsubscribe(); activity.dispose(); await Promise.allSettled(publications);
        transport.socket = null; socket.disconnect(); await client.shutdown();
    }
});
