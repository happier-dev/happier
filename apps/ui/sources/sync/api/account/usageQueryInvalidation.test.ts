import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { isUsageQuotaHomeAccountChange, getUsageProjectionNextReadAtMs, getUsageQueryMachineInvalidationKey, getUsageQueryPoolMachineSelection, observeUsageProjection, subscribeUsageQueryStateInvalidation } from './usageQueryInvalidation';
import { clearMachineRequestReachabilityForScope, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';
import { storage } from '@/sync/domains/state/storageStore';
import { handleEphemeralSocketUpdate } from '@/sync/engine/socket/socket';

afterEach(() => { vi.restoreAllMocks(); });

it('separates provider allowance publications from mixed, unknown and snapshot accounting wakes', () => {
    const quota = { serverId: 'server', entityIds: ['provider-account-usage'], changeKinds: ['account' as const], usageQueryAffects: true };
    expect(isUsageQuotaHomeAccountChange(quota)).toBe(true);
    expect(isUsageQuotaHomeAccountChange({ ...quota, entityIds: [buildConnectedServicesAccountChangeV1().entityId] })).toBe(true);
    for (const event of [
        { ...quota, entityIds: ['provider-account-usage', 'self'] },
        { ...quota, entityIds: [] },
        { ...quota, changeKinds: ['account' as const, 'session' as const] },
        { ...quota, source: 'snapshot' as const },
        { ...quota, usageAccountingChange: { sessionId: null } },
        { serverId: 'server' },
    ]) expect(isUsageQuotaHomeAccountChange(event)).toBe(false);
});

it.each(['failed', 'withdrawn'] as const)('distinguishes %s selector presence from confirmed offline Machines', condition => {
    const scope = { serverId: 'usage-selector-read-failure.test', accountId: 'account' };
    const machine = createMachineFixture({ id: 'chosen', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
    const machines = { [machine.id]: machine };
    observeMachinePresenceForTest(scope, [machine.id]);
    try {
        expect(getUsageQueryPoolMachineSelection(machines, ['chosen'], scope))
            .toEqual({ status: 'pending', machineId: 'chosen' });
        if (condition === 'failed') recordMachineRequestFailed({ ...scope, machineId: 'chosen' });
        else withdrawMachinePresenceForScope(scope);
        expect(getUsageQueryPoolMachineSelection(machines, ['chosen'], scope))
            .toEqual({ status: 'error', machineId: 'chosen', errorCode: 'MACHINE_RPC_UNREACHABLE' });
        clearMachineRequestReachabilityForScope(scope);
        observeMachinePresenceForTest(scope, ['chosen']);
        expect(getUsageQueryPoolMachineSelection({ chosen: { ...machine, active: false } }, ['chosen'], scope))
            .toEqual({ status: 'unsupported', errorCode: 'no_machine' });
        expect(getUsageQueryPoolMachineSelection({}, [], scope))
            .toEqual({ status: 'unsupported', errorCode: 'no_machine' });
    } finally { clearMachineRequestReachabilityForScope(scope); }
});

it('honors a positive predecessor acquisition deadline without adding a local floor', async () => {
    vi.useFakeTimers();
    const staleAfterMs = 100;
    let reads = 0;
    const deadline = getUsageProjectionNextReadAtMs({ legacyStaleAfterMs: staleAfterMs });
    const observation = observeUsageProjection({ serverId: 'predecessor-quota-deadline.test', initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; },
        nextReadAtMs: () => reads === 0 ? deadline : Number.POSITIVE_INFINITY });
    try {
        await vi.advanceTimersByTimeAsync(staleAfterMs - 1);
        expect(reads).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(reads).toBe(1);
    } finally { observation.dispose(); vi.useRealTimers(); }
});

it('refreshes quota acquisition for connected-service entities and the legacy broad signal', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const serverId = 'service-quota-currentness.test';
    const observation = observeUsageProjection({ serverId, initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; }, nextReadAtMs: () => Number.POSITIVE_INFINITY });
    try {
        await vi.advanceTimersByTimeAsync(0);
        for (const [index, change] of [
            buildConnectedServicesAccountChangeV1({ pluginId: 'acme.accounts', localId: 'service-a' }),
            buildConnectedServicesAccountChangeV1(),
        ].entries()) {
            publishHomeAccountChange(serverId, [change.entityId], { changeKinds: ['account'], usageQueryAffects: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(reads).toBe(index + 1);
        }
        publishHomeAccountChange(serverId, ['self']);
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(3);
        publishHomeAccountChange(serverId, ['self'], { changeKinds: ['account'], usageQueryAffects: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(3);
    } finally { observation.dispose(); vi.useRealTimers(); }
});

it('reconsiders existing accounts when their Usage capability arrives, but not when only its title changes', async () => {
    const previous = storage.getState();
    const scope = { serverId: 'usage-capability.test', accountId: 'account' };
    const service = { pluginId: 'acme.meter', localId: 'meter' };
    storage.setState({ profileScope: scope, profile: { ...previous.profile, connectedAccountsV4: [{
        ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
    }] } });
    const install = (capabilities: string[], title = 'Meter') => installConnectedAccountDescriptorProjection({
        scopeKey: 'capability', status: 'ready', conflicts: [], errorReason: null,
        descriptors: [{ id: service.localId, serviceId: service.localId, pluginId: service.pluginId, title, provenance: 'external',
            sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
                outcomeReconciliation: 'none', fields: [] }] }, capabilities,
            availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }],
    });
    install([]);
    let invalidations = 0;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidations++; });
    try {
        install(['usage']);
        expect(invalidations).toBe(1);
        install(['usage'], 'Renamed meter');
        expect(invalidations).toBe(1);
        install([]);
        expect(invalidations).toBe(2);
    } finally {
        release?.();
        installConnectedAccountDescriptorProjection({ scopeKey: 'capability', status: 'loading', conflicts: [], errorReason: null, descriptors: [] });
        storage.setState({ profile: previous.profile, profileScope: previous.profileScope });
    }
});

it('keeps a current-server quota reader idle and recovers on relevant pushes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const serverId = 'idle-current-usage.test';
    const observation = observeUsageProjection({ serverId, initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; },
        nextReadAtMs: () => getUsageProjectionNextReadAtMs() });
    try {
        for (let index = 0; index < 30; index++) {
            publishHomeAccountChange(serverId, ['unrelated-session'], { changeKinds: ['session'] });
            await vi.advanceTimersByTimeAsync(4_000);
        }
        expect(reads).toBe(0);
        publishHomeAccountChange(serverId, ['self', 'unrelated-session', 'machine-a'], {
            changeKinds: ['account', 'session', 'machine'], usageQueryAffects: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(0);
        publishHomeAccountChange(serverId, ['provider-account-usage'], {
            changeKinds: ['account'], usageQueryAffects: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(1);
        publishHomeAccountChange(serverId, ['self']);
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(2);
    } finally { observation.dispose(); vi.useRealTimers(); }
});

it.each(['usage', 'usage-sources-invalidated'] as const)('does not demand Provider quota for an accounting %s socket wake', async type => {
    let reads = 0;
    const observation = observeUsageProjection({
        serverId: 'usage-scoped-wake.test', initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; }, nextReadAtMs: () => Number.POSITIVE_INFINITY,
    });
    try {
        await handleEphemeralSocketUpdate({
            sourceServerId: 'usage-scoped-wake.test',
            update: type === 'usage'
                ? { type, id: null, key: 'agent:model', tokens: { total: 1 }, cost: { total: 0 }, timestamp: 1_000 }
                : { type, machineId: 'machine', installationId: 'installation' },
            addActivityUpdate: () => {}, addMachineActivityUpdate: () => {},
            getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {},
        });
        expect(reads).toBe(0);
    } finally { observation.dispose(); }
});

it('observes a completed initial read without repeating it and still reads on invalidation and expiry', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let deadline = Date.now() + 30_000;
    const observation = observeUsageProjection({
        serverId: 'completed-usage-read.test', initialReadCompleted: true, busy: () => false,
        read: async () => { reads++; deadline = Number.POSITIVE_INFINITY; },
        nextReadAtMs: () => deadline,
    });
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(0);
        observation.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(1);
        deadline = Date.now() + 30_000;
        observation.reconcile();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(reads).toBe(2);
    } finally {
        observation.dispose();
        vi.useRealTimers();
    }
});

it.each(['presentation', 'read'] as const)('preserves a long %s deadline through the native timer boundary', async kind => {
    vi.useFakeTimers();
    const nativeMaximum = 2_147_483_647;
    const schedule = globalThis.setTimeout;
    // Node/browser timer overflow is an environment boundary, not a shorter owner deadline.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
        schedule(callback, ms !== undefined && ms > nativeMaximum ? 1 : ms, ...args));
    const deadline = Date.now() + nativeMaximum + 100;
    let readDeadline = deadline;
    let reads = 0;
    let publications = 0;
    const observation = observeUsageProjection({
        serverId: 'long-usage-deadline.test', busy: () => false,
        read: async () => { reads++; if (reads > 1) readDeadline = Number.POSITIVE_INFINITY; },
        nextReadAtMs: () => kind === 'read' ? readDeadline : Number.POSITIVE_INFINITY,
        presentationDeadlineMs: () => kind === 'presentation' ? deadline : undefined,
        publish: () => { publications++; },
    });
    try {
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(1);
        expect(publications).toBe(0);
        await vi.advanceTimersByTimeAsync(nativeMaximum - 100);
        expect(reads).toBe(1);
        expect(publications).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(kind === 'read' ? 2 : 1);
        expect(publications).toBe(kind === 'presentation' ? 1 : 0);
    } finally {
        observation.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    }
});

it('keeps presence heartbeats from changing the usage Resource machine invalidation key', () => {
    const scope = { serverId: 'usage-invalidation.test', accountId: 'account-a' };
    const machine = createMachineFixture({ id: 'machine', activeAt: 1_900_000_000_000, updatedAt: 1_900_000_000_000 });
    const key = getUsageQueryMachineInvalidationKey({ [machine.id]: machine }, machine.activeAt!, scope);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, activeAt: machine.activeAt! + 1, updatedAt: machine.updatedAt + 1 },
    }, machine.activeAt!, scope)).toBe(key);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed' } },
    }, machine.activeAt!, scope)).not.toBe(key);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, revokedAt: machine.activeAt },
    }, machine.activeAt!, scope)).toBe(key); // Coverage labels consume identity/name only.
});

it('keys pool selection by its resolved machine and Session evidence by only its hosting machines', () => {
    const nowMs = 1_900_000_000_000;
    const scope = { serverId: 'usage-machine-consumers.test', accountId: 'account-a' };
    const machines = Object.fromEntries(['a', 'b', 'c'].map(id => [id, createMachineFixture({ id, activeAt: nowMs })]));
    const consumers = { includeMachineNames: false, poolMachineFilters: [[]], sessionMachineIds: [] };
    const key = getUsageQueryMachineInvalidationKey(machines, nowMs, scope, consumers);
    expect(getUsageQueryMachineInvalidationKey({ ...machines,
        a: { ...machines.a!, metadata: { ...machines.a!.metadata!, displayName: 'Renamed' } },
        d: createMachineFixture({ id: 'd', activeAt: nowMs }),
    }, nowMs, scope, consumers)).toBe(key); // The pool remains ambiguous; neither name is quota evidence.
    const two = { ...machines, c: { ...machines.c!, active: false, activeAt: 1 } };
    expect(getUsageQueryMachineInvalidationKey(two, nowMs, scope, consumers)).toBe(key);
    const one = { ...two, b: { ...machines.b!, active: false, activeAt: 1 } };
    expect(getUsageQueryMachineInvalidationKey(one, nowMs, scope, consumers)).not.toBe(key);
    const sessionConsumers = { poolMachineFilters: [], sessionMachineIds: ['a'] };
    const sessionKey = getUsageQueryMachineInvalidationKey(machines, nowMs, scope, sessionConsumers);
    expect(getUsageQueryMachineInvalidationKey(two, nowMs, scope, sessionConsumers)).toBe(sessionKey);
    expect(getUsageQueryMachineInvalidationKey({ ...machines, a: { ...machines.a!, active: false, activeAt: 1 } }, nowMs, scope, sessionConsumers)).not.toBe(sessionKey);
    expect(getUsageQueryMachineInvalidationKey({ ...machines, a: { ...machines.a!, replacedByMachineId: 'b' } }, nowMs, scope, sessionConsumers)).not.toBe(sessionKey);
});

it('ignores equivalent Profile and Settings refreshes but invalidates changed quota inputs', async () => {
    const previous = storage.getState();
    const scope = { serverId: 'usage-invalidation.test', accountId: 'account-a' };
    storage.setState({ profileScope: scope, settingsScope: scope,
        profile: { ...previous.profile, connectedAccountsV4: [{
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
            status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
        }] } });
    let invalidations = 0;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidations++; });
    try {
        for (let index = 0; index < 8; index++) {
            const state = storage.getState();
            storage.setState({ profileScope: { ...scope }, settingsScope: { ...scope },
                profile: { ...state.profile, connectedAccountsV4: structuredClone(state.profile.connectedAccountsV4),
                    connectedAccountGroupsV4: structuredClone(state.profile.connectedAccountGroupsV4) },
                settings: { ...state.settings, featureToggles: { ...state.settings.featureToggles } } });
        }
        expect(invalidations).toBe(0);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, lastUsedAt: Date.now(),
        })) } }));
        expect(invalidations).toBe(0);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => account.revisionSemantics === 'revisioned'
            ? { ...account, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz_replaced' } : account) } }));
        expect(invalidations).toBe(1);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, status: 'needs_reauth' as const,
        })) } }));
        expect(invalidations).toBe(2);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, configurationReady: true, configurationRevision: 'configuration-replaced',
        })) } }));
        expect(invalidations).toBe(3);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, ref: { ...account.ref, accountId: 'replacement-account' },
        })) } }));
        expect(invalidations).toBe(4);
        const state = storage.getState();
        storage.setState({ settings: { ...state.settings, experiments: !state.settings.experiments } });
        expect(invalidations).toBe(5);
        storage.setState({ settingsScope: { ...scope, accountId: 'other-account' } });
        expect(invalidations).toBe(6);
        storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [] } });
        expect(invalidations).toBe(7);
    } finally {
        release?.();
        storage.setState({ profile: previous.profile, profileScope: previous.profileScope,
            settings: previous.settings, settingsScope: previous.settingsScope });
    }
});

it('separates presentation settings and Machine labels from selection eligibility', async () => {
    const previous = storage.getState();
    const scope = { serverId: 'usage-projection-classification.test', accountId: 'account-a' };
    const machine = createMachineFixture({ id: 'projection-machine', activeAt: Date.now() });
    storage.setState({ profileScope: scope, settingsScope: scope, machines: { [machine.id]: machine } });
    const invalidations: string[] = [];
    const release = subscribeUsageQueryStateInvalidation(input => invalidations.push(input), () => ({
        includeMachineNames: true, poolMachineFilters: [[]], sessionMachineIds: [machine.id],
    }));
    try {
        storage.setState(state => ({ settings: { ...state.settings, usageNightHoursV1: { startHour: 23, endHour: 7 } } }));
        expect(invalidations.splice(0)).toEqual(['projection-inputs']);
        storage.setState({ machines: { [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed' } } } });
        expect(invalidations.splice(0)).toEqual(['projection-inputs']);
        storage.setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: 1 } } });
        expect(invalidations.splice(0)).toEqual(['quota-inputs']);
    } finally {
        release?.();
        storage.setState({ profileScope: previous.profileScope, settingsScope: previous.settingsScope,
            settings: previous.settings, machines: previous.machines });
    }
});

it('does not reread machine details for unrelated store notifications or wall time, but observes pushed presence', async () => {
    let nowMs = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const machine = createMachineFixture({ id: 'machine', activeAt: nowMs, updatedAt: nowMs, presenceProtocolVersion: 1 });
    const metadata = machine.metadata;
    let detailReads = 0;
    Object.defineProperty(machine, 'metadata', { enumerable: true, get() { detailReads++; return metadata; } });
    const previousMachines = storage.getState().machines;
    const previousReady = storage.getState().isDataReady;
    const previousSettingsScope = storage.getState().settingsScope;
    const previousProfileScope = storage.getState().profileScope;
    const scope = { serverId: 'usage-invalidation.test', accountId: 'account-a' };
    storage.setState({ machines: { [machine.id]: machine }, profileScope: scope });
    observeMachinePresenceForTest(scope, [machine.id]);
    let invalidated = false;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidated = true; }, () => ({
        poolMachineFilters: [[machine.id]], sessionMachineIds: [],
    }));
    try {
        detailReads = 0;
        for (let index = 0; index < 128; index++) storage.setState({ isDataReady: !storage.getState().isDataReady });
        const unrelatedDetailReads = detailReads;
        expect(invalidated).toBe(false);
        nowMs += 120_000;
        storage.setState({ isDataReady: !storage.getState().isDataReady });
        expect(invalidated).toBe(false);
        storage.setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: nowMs } } });
        expect(invalidated).toBe(true);
        expect(detailReads).toBeGreaterThan(unrelatedDetailReads);
        console.info(JSON.stringify({ unrelatedStoreRevisions: 128, unrelatedMachineDetailReads: unrelatedDetailReads, expiryDetailReads: detailReads - unrelatedDetailReads }));
        expect(unrelatedDetailReads).toBe(0);
        invalidated = false;
        nowMs = machine.activeAt!;
        storage.setState({ isDataReady: !storage.getState().isDataReady });
        expect(invalidated).toBe(false);
        invalidated = false;
        storage.setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: nowMs + 1, updatedAt: nowMs + 1 } } });
        expect(invalidated).toBe(false);
        const beforeScopeChange = detailReads;
        storage.setState({ settingsScope: { serverId: 'usage-invalidation.test', accountId: 'other-account' } });
        expect(invalidated).toBe(true);
        expect(detailReads).toBe(beforeScopeChange);
    } finally {
        release?.();
        clearMachineRequestReachabilityForScope(scope);
        storage.setState({ machines: previousMachines, isDataReady: previousReady, settingsScope: previousSettingsScope, profileScope: previousProfileScope });
    }
});
