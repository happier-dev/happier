import { describe, expect, it } from 'vitest';

import {
    buildSessionGettingStartedViewModel,
    computeMachinesSummary,
    computeSessionGettingStartedDecision,
    resolveActiveServerProfile,
    resolveSessionGettingStartedMachinesSummary,
} from './gettingStartedModel';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

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

    it('returns select_session when sessions exist even if no machines are currently known', () => {
        const machines = computeMachinesSummary([{ machineCount: 0, onlineCount: 0 }]);
        expect(computeSessionGettingStartedDecision({ sessionsReady: true, sessionCount: 3, machines })).toBe('select_session');
    });
});

describe('buildSessionGettingStartedViewModel', () => {
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
                srv_local_relay: [{ active: true }],
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
                'srv-a': [{ active: true }],
            },
        })).toEqual({
            hasUnknownServers: false,
            machineCount: 1,
            onlineCount: 1,
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
        const input: any = {
            sessions: null,
            sessionsReady: true,
            sessionCount: 1,
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: { 'srv-a': [{ active: true }] },
        };
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
            activeMachines: [{ active: true }],
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

    it('treats a healthy local daemon as an online machine when the active server cache is empty', () => {
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
            localDaemonStatus: {
                serviceInstalled: true,
                daemonRunning: true,
                needsAuth: false,
                machineId: 'machine-1',
            },
        });

        expect(model.kind).toBe('create_session');
    });

    it('treats a healthy local daemon as an online machine when the active server cache only reports offline machines', () => {
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
            machineListByServerId: { 'srv-a': [{ active: false }] },
            localDaemonStatus: {
                serviceInstalled: true,
                daemonRunning: true,
                needsAuth: false,
                machineId: 'machine-1',
            },
        });

        expect(model.kind).toBe('create_session');
    });

    it('falls back to the active machine list when no visible server ids are selected', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [{ active: true }],
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
            activeMachines: [{ active: true }],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-b' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-b'],
            },
            serverSelectionGroups: [],
            activeServerProfile: { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
            machineListByServerId: {
                'srv-a': [{ active: true }],
                'srv-b': [],
            },
        });

        expect(model.kind).toBe('create_session');
    });

    it('keeps loading when the selected scope machine cache is still unknown even if the active server has machines', () => {
        const model = buildSessionGettingStartedViewModel({
            sessionsReady: true,
            sessionCount: 0,
            activeMachines: [{ active: true }],
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
});
