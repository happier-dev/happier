import { describe, expect, it } from 'vitest';

import { buildSessionGettingStartedViewModel, computeMachinesSummary, computeSessionGettingStartedDecision } from './gettingStartedModel';

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
});

describe('buildSessionGettingStartedViewModel', () => {
    it('uses group name as target label when active target is a group', () => {
        const model = buildSessionGettingStartedViewModel({
            sessions: [],
            selection: {
                activeTarget: { kind: 'group', id: 'g1', groupId: 'g1' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a', 'srv-b'],
            },
            serverSelectionGroups: [{ id: 'g1', name: 'Company Servers' }],
            serverProfiles: [
                { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
                { id: 'srv-b', name: 'B', serverUrl: 'https://api.b.example' },
            ],
            machineListByServerId: { 'srv-a': [], 'srv-b': [] },
            machineListStatusByServerId: { 'srv-a': 'idle', 'srv-b': 'idle' },
        });
        expect(model.targetLabel).toBe('Company Servers');
    });

    it('shows server setup command for non-cloud servers', () => {
        const model = buildSessionGettingStartedViewModel({
            sessions: [],
            selection: {
                activeTarget: { kind: 'server', id: 'srv-a' },
                activeServerId: 'srv-a',
                allowedServerIds: ['srv-a'],
            },
            serverSelectionGroups: [],
            serverProfiles: [{ id: 'srv-a', name: 'Company', serverUrl: 'https://api.company.example' }],
            machineListByServerId: { 'srv-a': [] },
            machineListStatusByServerId: { 'srv-a': 'idle' },
        });
        expect(model.showServerSetup).toBe(true);
    });

    it('does not show server setup command for Happier Cloud', () => {
        const model = buildSessionGettingStartedViewModel({
            sessions: [],
            selection: {
                activeTarget: { kind: 'server', id: 'cloud' },
                activeServerId: 'cloud',
                allowedServerIds: ['cloud'],
            },
            serverSelectionGroups: [],
            serverProfiles: [{ id: 'cloud', name: 'Happier Cloud', serverUrl: 'https://api.happier.dev' }],
            machineListByServerId: { cloud: [] },
            machineListStatusByServerId: { cloud: 'idle' },
        });
        expect(model.showServerSetup).toBe(false);
    });
});
