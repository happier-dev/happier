import { describe, expect, it, vi } from 'vitest';

import {
    buildSessionGettingStartedViewModel as buildScopedViewModel,
    computeMachinesSummary,
    computeSessionGettingStartedDecision,
    resolveActiveServerProfile,
    resolveSessionGettingStartedMachinesSummary as resolveScopedMachinesSummary,
    resolveSessionGettingStartedMachineSetupSatisfied,
    type SessionGettingStartedMachinesInput,
} from './gettingStartedModel';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/serverCredentialAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit';
import { recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';

type FixtureMachinesInput = Omit<SessionGettingStartedMachinesInput, 'activeMachines' | 'machineListByServerId'> & {
    activeMachines: readonly Partial<Machine>[];
    machineListByServerId: Readonly<Record<string, readonly Partial<Machine>[] | null | undefined>>;
};
function normalizeFixtureMachines(input: FixtureMachinesInput): SessionGettingStartedMachinesInput {
    const machines = (rows: readonly Partial<Machine>[]) => rows.map((row, index) => createMachineFixture({
        ...row, id: row.id ?? `fixture-machine-${index}`, activeAt: row.activeAt ?? (row.active === true ? Date.now() : 0),
    }));
    const serverIds = new Set([...input.selection.allowedServerIds, input.selection.activeServerId, ...Object.keys(input.machineListByServerId)]);
    return { ...input, activeMachines: machines(input.activeMachines),
        machineListByServerId: Object.fromEntries(Object.entries(input.machineListByServerId)
            .map(([serverId, rows]) => [serverId, rows ? machines(rows) : rows])),
        accountScopeResolutionsByServerId: input.accountScopeResolutionsByServerId ?? new Map([...serverIds].map(serverId => [serverId, { kind: 'bound' as const, scope: { serverId, accountId: 'guidance-account' } }])),
    };
}
function buildSessionGettingStartedViewModel(input: Omit<Parameters<typeof buildScopedViewModel>[0], 'activeMachines' | 'machineListByServerId'> & FixtureMachinesInput) {
    return buildScopedViewModel({ ...input, ...normalizeFixtureMachines(input), activeServerProfile: input.activeServerProfile });
}
function resolveSessionGettingStartedMachinesSummary(input: FixtureMachinesInput) {
    const normalized = normalizeFixtureMachines(input);
    const summary = resolveScopedMachinesSummary(normalized);
    // Both questions share Home/status/alias/fallback policy; setup differs only
    // in needing existence rather than count, presentation or online detail.
    expect(resolveSessionGettingStartedMachineSetupSatisfied(normalized))
        .toBe(summary.machineCount > 0 ? true : summary.hasUnknownServers ? null : false);
    return summary;
}

describe('computeSessionGettingStartedDecision', () => {
    it('returns loading when sessions are not ready', () => {
        const machines = computeMachinesSummary([{ machineCount: 0, onlineCount: 0 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: false, sessionCount: 0, machines })).toBe('loading');
    });

    it('returns loading when machines are unknown and none are known yet', () => {
        const machines = computeMachinesSummary([{ machineCount: null, onlineCount: null }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 0, machines })).toBe('loading');
    });

    it('returns connect_machine when there are no machines', () => {
        const machines = computeMachinesSummary([{ machineCount: 0, onlineCount: 0 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 0, machines })).toBe('connect_machine');
    });

    it('returns start_daemon when machines exist but all are offline', () => {
        const machines = computeMachinesSummary([{ machineCount: 2, onlineCount: 0 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 0, machines })).toBe('start_daemon');
    });

    it('returns create_session when machines are online but there are no sessions', () => {
        const machines = computeMachinesSummary([{ machineCount: 1, onlineCount: 1 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 0, machines })).toBe('create_session');
    });

    it('returns select_session when sessions exist', () => {
        const machines = computeMachinesSummary([{ machineCount: 1, onlineCount: 1 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 3, machines })).toBe('select_session');
    });

    it('returns connect_machine when sessions exist but no machine is available for a new session', () => {
        const machines = computeMachinesSummary([{ machineCount: 0, onlineCount: 0 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 3, machines })).toBe('connect_machine');
    });

    it('keeps existing sessions selectable while machine availability is still unknown', () => {
        const machines = computeMachinesSummary([{ machineCount: null, onlineCount: null }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 3, machines })).toBe('select_session');
    });
});

describe('buildSessionGettingStartedViewModel', () => {
    it.each([
        { availability: { kind: 'locked' as const, reason: 'content_unreadable' as const }, metadata: null },
        { availability: { kind: 'available' as const }, metadata: null, active: true, activeAt: Date.now() },
    ])('FX28 settles unavailable Machine content into setup guidance: %j', machineContent => {
        const serverId = 'fx28-locked-home';
        const machine = createMachineFixture({ id: 'fx28-locked-machine', active: false, ...machineContent });
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true, sessionCount: 0, activeMachines: [machine],
            selection: { activeTarget: { kind: 'server', id: serverId }, activeServerId: serverId, allowedServerIds: [serverId] },
            serverSelectionGroups: [], activeServerProfile: { id: serverId, name: 'Studio', serverUrl: 'https://fx28.test' },
            machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' },
        });
        expect(model.kind).toBe('start_daemon');
    });

    it.each(['signed_out', 'unavailable', 'unknown_home'] as const)('FX28 reports settled %s credentials rather than waiting for presence', kind => {
        const serverId = 'fx28-terminal-home';
        const machine = createMachineFixture({ id: 'fx28-terminal-machine', activeAt: Date.now() });
        const input = {
            sessionsReady: true, sessionCount: 0, activeMachines: [machine],
            selection: { activeTarget: { kind: 'server' as const, id: serverId }, activeServerId: serverId, allowedServerIds: [serverId] },
            serverSelectionGroups: [], activeServerProfile: { id: serverId, name: 'Studio', serverUrl: 'https://fx28.test' },
            machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' as const },
            accountScopeResolutionsByServerId: new Map<string, ServerCredentialAccountScopeResolution>([[serverId, { kind }]]),
        };
        expect(buildScopedViewModel(input)).toMatchObject({ kind: 'start_daemon', unavailableServerIds: [serverId] });
        // An unbound Home cannot finish its first Session read until credentials recover.
        expect(buildScopedViewModel({ ...input, sessionsReady: false }).kind).toBe('start_daemon');
        const pending = { ...input, sessionsReady: false,
            accountScopeResolutionsByServerId: new Map<string, ServerCredentialAccountScopeResolution>([[serverId, { kind: 'resolving' }]]),
        };
        expect(buildScopedViewModel(pending).kind).toBe('loading');
        expect(buildScopedViewModel({ ...input, activeMachines: [], machineListByServerId: {} }))
            .toMatchObject({ kind: 'connect_machine', unavailableServerIds: [serverId] });
        expect(buildScopedViewModel({ ...input, sessionCount: 1 }).kind).toBe('select_session');
    });
    it('keeps unknown daemon presence separate from known stopped Machines', () => {
        const serverId = 'pending-daemon-home';
        const accountId = 'pending-daemon-account';
        const machine = createMachineFixture({ id: 'pending-daemon-machine', activeAt: Date.now() });
        const input = { sessionsReady: true, sessionCount: 0, activeMachines: [machine],
            selection: { activeTarget: { kind: 'server' as const, id: serverId }, activeServerId: serverId, allowedServerIds: [serverId] },
            serverSelectionGroups: [], activeServerProfile: { id: serverId, name: 'Studio', serverUrl: 'https://pending-daemon.test' },
            machineListByServerId: { [serverId]: [machine] }, accountScopeResolutionsByServerId: new Map() };
        expect(resolveScopedMachinesSummary(input)).toMatchObject({ machineCount: 1, onlineCount: 0, hasUnknownServers: true });
        expect(resolveSessionGettingStartedMachineSetupSatisfied(input)).toBe(true);
        expect(buildScopedViewModel(input).kind).toBe('loading');
        expect(buildScopedViewModel({ ...input, sessionCount: 1 }).kind).toBe('select_session');
        const bound = { ...input, accountScopeResolutionsByServerId: new Map([[serverId, { kind: 'bound' as const, scope: { serverId, accountId } }]]) };
        expect(buildScopedViewModel(bound).kind).toBe('create_session');
        recordMachineRequestFailed({ serverId, accountId, machineId: machine.id });
        try { expect(buildScopedViewModel(bound).kind).toBe('start_daemon'); }
        finally { recordMachineRequestSucceeded({ serverId, accountId, machineId: machine.id }); }
    });

    it('waits on unresolved selected Homes only when no known Machine can start a Session', () => {
        const known = computeMachinesSummary([{ machineCount: 1, onlineCount: 0 }, { machineCount: null, onlineCount: null }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 0, machines: known })).toBe('loading');
        const ready = computeMachinesSummary([{ machineCount: 1, onlineCount: 1 }, { machineCount: null, onlineCount: null }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 0, machines: ready })).toBe('create_session');
    });

    it('reads profile identity once per bulk summary and refreshes it on the next invocation', async () => {
        const { MMKV } = await import('react-native-mmkv');
        const { setServerProfileIdentityForUrl, upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const profile = await upsertServerProfile({ serverUrl: 'https://bulk-guidance.example.test', name: 'Bulk guidance' });
        const serverId = profile.id;
        const identity = 'srv_bulk_guidance';
        const machines = Array.from({ length: 138 }, (_, index) => createMachineFixture({
            id: `bulk-guidance-${index}`, active: true, activeAt: Date.now(),
        }));
        const read = (rows: readonly Machine[]) => resolveScopedMachinesSummary({
            selection: { activeTarget: { kind: 'server', id: serverId }, activeServerId: serverId, allowedServerIds: [serverId] },
            activeMachines: rows, machineListByServerId: { [serverId]: rows },
            accountScopeResolutionsByServerId: new Map([[serverId, { kind: 'bound', scope: { serverId, accountId: 'bulk-guidance-account' } }]]),
        });
        // Observe the canonical native storage boundary; all identity and fleet logic remains real.
        const reads = vi.spyOn(MMKV.prototype, 'getString');
        try {
            expect(read(machines.slice(0, 1))).toMatchObject({ machineCount: 1, onlineCount: 1, hasUnknownServers: false });
            const oneMachineReads = reads.mock.calls.filter(([key]) => key === 'server-state-v1').length;
            reads.mockClear();
            expect(read(machines)).toMatchObject({ machineCount: 138, onlineCount: 138, hasUnknownServers: false });
            const fleetReads = reads.mock.calls.filter(([key]) => key === 'server-state-v1').length;
            expect({ oneMachineReads, fleetReads }).toEqual({ oneMachineReads: 1, fleetReads: 1 });

            recordMachineRequestFailed({ serverId: identity, accountId: 'bulk-guidance-account', machineId: machines[0]!.id });
            expect(read(machines).onlineCount).toBe(138);
            await setServerProfileIdentityForUrl(profile.serverUrl, identity);
            reads.mockClear();
            expect(read(machines).onlineCount).toBe(137);
            expect(reads.mock.calls.filter(([key]) => key === 'server-state-v1')).toHaveLength(1);
            recordMachineRequestSucceeded({ serverId: identity, accountId: 'bulk-guidance-account', machineId: machines[0]!.id });
            expect(read(machines).onlineCount).toBe(138);
        } finally {
            reads.mockRestore();
            recordMachineRequestSucceeded({ serverId: identity, accountId: 'bulk-guidance-account', machineId: machines[0]!.id });
        }
    });
    it('does not offer session creation from a request-failed or replaced fleet member', () => {
        const serverId = 'fleet-guidance-home';
        const machine = createMachineFixture({ id: 'fleet-guidance-machine', active: true, activeAt: Date.now() });
        const input = { sessionsReady: true, sessionCount: 0, activeMachines: [machine],
            selection: { activeTarget: { kind: 'server' as const, id: serverId }, activeServerId: serverId, allowedServerIds: [serverId] },
            serverSelectionGroups: [], activeServerProfile: { id: serverId, name: 'Studio', serverUrl: 'https://fleet-guidance.test' },
            machineListByServerId: { [serverId]: [machine] } };
        recordMachineRequestFailed({ serverId, accountId: 'guidance-account', machineId: machine.id });
        try {
            expect(buildSessionGettingStartedViewModel(input).kind).toBe('start_daemon');
            recordMachineRequestSucceeded({ serverId, accountId: 'guidance-account', machineId: machine.id });
            expect(buildSessionGettingStartedViewModel(input).kind).toBe('create_session');
            const replaced = { ...machine, replacedByMachineId: 'new-machine' };
            expect(buildSessionGettingStartedViewModel({ ...input, activeMachines: [replaced],
                machineListByServerId: { [serverId]: [replaced] } }).kind).toBe('start_daemon');
        } finally { recordMachineRequestSucceeded({ serverId, accountId: 'guidance-account', machineId: machine.id }); }
    });
    it('names the selected Home by its published name even when the saved label is a raw host', () => {
        const profile = { id: 'named-home', name: 'localhost:52753', serverUrl: 'http://localhost:52753' };
        primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            const model = buildSessionGettingStartedViewModel({
                sessionsReady: true, sessionCount: 0, activeMachines: [],
                selection: { activeTarget: { kind: 'server', id: profile.id }, activeServerId: profile.id, allowedServerIds: [profile.id] },
                serverSelectionGroups: [], activeServerProfile: profile,
                machineListByServerId: { [profile.id]: [] },
            });
            expect(model).toMatchObject({ kind: 'connect_machine', targetLabel: 'Studio Home', serverName: 'Studio Home' });
        } finally {
            deleteServerFeaturesSnapshot({ serverId: profile.id });
        }
    });
    it('resolves the active server profile with the canonical fallback order', () => {
        expect(resolveActiveServerProfile([
            { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            { id: 'srv-b', name: 'B', serverUrl: 'https://api.b.example' },
        ], 'srv-b')).toEqual({
            id: 'srv-b',
            name: 'B',
            serverUrl: 'https://api.b.example',
            serverIdentityId: null,
            legacyServerIds: [],
        });
        expect(resolveActiveServerProfile([
            { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
        ], 'missing')).toEqual({
            id: 'srv-a',
            name: 'A',
            serverUrl: 'https://api.a.example',
            serverIdentityId: null,
            legacyServerIds: [],
        });
    });

    it('resolves the active server profile by server identity and legacy aliases', () => {
        const profiles: Array<Pick<ServerProfile, 'id' | 'name' | 'serverUrl' | 'serverIdentityId' | 'legacyServerIds'>> = [
            { id: 'localhost-18830', name: 'localhost:18830', serverUrl: 'http://localhost:18830' },
            {
                id: 'localhost-52753',
                name: 'localhost:52753',
                serverUrl: 'http://localhost:52753',
                serverIdentityId: 'srv_local_relay',
                legacyServerIds: ['old-local-relay'],
            },
        ];

        expect(resolveActiveServerProfile(profiles, 'srv_local_relay')).toEqual({
            id: 'localhost-52753',
            name: 'localhost:52753',
            serverUrl: 'http://localhost:52753',
            serverIdentityId: 'srv_local_relay',
            legacyServerIds: ['old-local-relay'],
        });
        expect(resolveActiveServerProfile(profiles, 'old-local-relay')).toEqual({
            id: 'localhost-52753',
            name: 'localhost:52753',
            serverUrl: 'http://localhost:52753',
            serverIdentityId: 'srv_local_relay',
            legacyServerIds: ['old-local-relay'],
        });
    });

    it('uses active server profile identity aliases when resolving scoped machines', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'localhost-64115' },
                activeServerId: 'localhost-64115',
                allowedServerIds: ['localhost-64115'],
            },
            serverSelectionGroups: [],
            activeServerProfile: {
                id: 'localhost-64115',
                name: 'localhost:64115',
                serverUrl: 'http://127.0.0.1:64115',
                serverIdentityId: 'srv_local_relay',
                legacyServerIds: ['old-local-relay'],
            } as any,
            machineListByServerId: {
                srv_local_relay: [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            },
        });

        expect(model.kind).toBe('create_session');
    });

    it('resolves active-server machines when profile aliases are unavailable', () => {
        expect(resolveSessionGettingStartedMachinesSummary({
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            machineListByServerId: {
                'srv-a': [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            },
        })).toEqual({
            hasUnknownServers: false,
            machineCount: 1,
            onlineCount: 1,
            unavailableServerIds: [],
        });
    });

    it('prefers direct server profile ids over identity and legacy aliases', () => {
        const profiles: Array<Pick<ServerProfile, 'id' | 'name' | 'serverUrl' | 'serverIdentityId' | 'legacyServerIds'>> = [
            {
                id: 'old-profile',
                name: 'Old profile',
                serverUrl: 'https://old.example',
                serverIdentityId: 'current-profile',
                legacyServerIds: ['legacy-collision'],
            },
            {
                id: 'current-profile',
                name: 'Current profile',
                serverUrl: 'https://current.example',
            },
            {
                id: 'legacy-collision',
                name: 'Legacy collision profile',
                serverUrl: 'https://legacy-collision.example',
            },
        ];

        expect(resolveActiveServerProfile(profiles, 'current-profile')).toEqual({
            id: 'current-profile',
            name: 'Current profile',
            serverUrl: 'https://current.example',
            serverIdentityId: null,
            legacyServerIds: [],
        });
        expect(resolveActiveServerProfile(profiles, 'legacy-collision')).toEqual({
            id: 'legacy-collision',
            name: 'Legacy collision profile',
            serverUrl: 'https://legacy-collision.example',
            serverIdentityId: null,
            legacyServerIds: [],
        });
    });

    it('uses the canonical session-ready summary instead of the raw sessions array', () => {
        const input = {
            sessions: null,
            sessionsReady: true,
            sessionCount: 1,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })] },
        } as const;
        const model = buildSessionGettingStartedViewModel(input);

        expect(model.kind).toBe('select_session');
    });

    it('uses group name as target label when active target is a group', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'group', id: 'g1', groupId: 'g1' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a', 'srv-b'],
            },
            serverSelectionGroups: [{ id: 'g1', name: 'Company Servers' }],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [], 'srv-b': [] },
        });
        expect(model.targetLabel).toBe('Company Servers');
    });

    it('shows server setup command for non-cloud servers', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'Company', serverUrl: 'https://api.company.example' },
            machineListByServerId: { 'srv-a': [] },
        });
        expect(model.showServerSetup).toBe(true);
    });

    it('does not show server setup command for Happier Cloud', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'cloud' },
                activeServerId: 'cloud',
                allowedServerIds: ['cloud'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'cloud', name: 'Happier Cloud', serverUrl: 'https://api.happier.dev' },
            machineListByServerId: { cloud: [] },
        });
        expect(model.showServerSetup).toBe(false);
    });

    it('falls back to active machines when the active server scoped cache is empty', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [] },
        });

        expect(model.kind).toBe('create_session');
    });

    it('does not count a local daemon the account machine list does not contain', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [] },
        });

        expect(model.kind).toBe('connect_machine');
    });

    it('falls back to the active machine list when no visible server ids are selected', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: [],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: {},
        });

        expect(model.kind).toBe('create_session');
    });

    it('falls back to the active server machines when the selected scope points elsewhere and is empty', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-b' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-b'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: {
                'srv-a': [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
                'srv-b': [],
            },
        });

        expect(model.kind).toBe('create_session');
    });

    it('keeps loading when the selected scope machine cache is still unknown even if the active server has machines', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-b' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-b'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: {
                'srv-a': [{ active: true }],
            },
        });

        expect(model.kind).toBe('loading');
    });

    it('never waits on a Home that is not answering: the active Home decides, and the other Home is reported', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })],
            selection: {
                activeTarget: { kind: 'group', id: 'g', groupId: 'g' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a', 'srv-b'],
            },
            serverSelectionGroups: [{ id: 'g', name: 'All' }],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [createMachineFixture({ id: 'guidance-active', active: true, activeAt: Date.now() })] },
            machineListStatusByServerId: { 'srv-a': 'idle', 'srv-b': 'error' },
        });

        expect(model.kind).toBe('create_session');
        expect(model.unavailableServerIds).toEqual(['srv-b']);
    });

    it('answers from the active Home when the only other selected Home is not answering', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-b' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-b'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [] },
            machineListStatusByServerId: { 'srv-b': 'error' },
        });

        expect(model.kind).toBe('connect_machine');
        expect(model.unavailableServerIds).toEqual(['srv-b']);
    });
});
