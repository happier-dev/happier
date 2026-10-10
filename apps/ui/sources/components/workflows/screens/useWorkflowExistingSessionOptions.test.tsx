import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createSessionFixture, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useWorkflowExistingSessionOptions } from './useWorkflowExistingSessionOptions';

describe('Workflow existing Session options', () => {
    it('ignores unrelated publications but refreshes names, candidacy and exact Machine selection', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'workflow-option', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!,
            flavor: 'claude', claudeSessionId: 'resume-id', claudeTranscriptPath: '/tmp/transcript.jsonl',
            machineId: 'machine-a', path: '/repo', name: 'Original',
        } });
        let renders = 0;
        storage.setState({ isDataReady: true, sessions: { [session.id]: session } });
        const hook = await renderHook(() => {
            renders += 1;
            return useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a' });
        });
        try {
            expect(hook.getCurrent().existingSessions).toMatchObject([{ sessionId: session.id, machineId: 'machine-a' }]);
            const initial = hook.getCurrent();
            const before = renders;
            await act(async () => { storage.setState(state => ({
                settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut },
                sessions: { ...state.sessions, [session.id]: { ...session, updatedAt: session.updatedAt + 1 } },
            })); });
            expect(hook.getCurrent()).toBe(initial);
            expect(renders).toBe(before);
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, name: 'Renamed' },
            } } }); });
            expect(hook.getCurrent().existingSessions[0]?.label).toBe('Renamed');
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, machineId: 'machine-b' },
            } } }); });
            expect(hook.getCurrent().existingSessions).toEqual([]);
            expect(hook.getCurrent().sessionDropCandidates[0]?.machineId).toBe('machine-b');
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, claudeSessionId: undefined, claudeTranscriptPath: undefined },
            } } }); });
            expect(hook.getCurrent().sessionDropCandidates).toEqual([]);
        } finally { await hook.unmount(); storage.setState(previous); }
    });
});
