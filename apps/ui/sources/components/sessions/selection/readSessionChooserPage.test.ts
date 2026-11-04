import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionChooserPage } from './readSessionChooserPage';
import * as sessionPresentation from '@/utils/sessions/sessionUtils';
import { projectSessionSelectionRows } from './projectSessionSelectionRows';
import { resetSessionSurfaceVisibilityForTests, setFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { sessionMruState } from '@/sync/domains/session/navigation/recentSessions';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const initialState = storage.getState();
afterEach(() => { storage.setState(initialState, true); vi.restoreAllMocks(); resetSessionSurfaceVisibilityForTests(); sessionMruState.set('order', []); });

describe('Session chooser snapshot pages', () => {
    it('places the focused address before MRU across Homes, then the existing activity order', () => {
        const sessions = ['focused', 'recent', 'latest'].map((id, index) => createSessionFixture({
            id, serverId: 'home-a', createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000 + index * 1000, meaningfulActivityAt: 1_700_000_000_000 + index * 1000,
            metadata: { path: '/project', host: 'machine', name: id },
        }));
        storage.setState({ sessions: {}, sessionListIndexByServerId: {},
            sessionListRowsByServerId: { 'home-a': Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
            ordinarySessionListMembershipByServerId: { 'home-a': sessions.map(session => session.id) } });
        setFocusedSessionId('focused', 'home-a');
        sessionMruState.set('order', [sessionAddressKey({ serverId: 'home-a', sessionId: 'recent' })]);
        expect(readSessionChooserPage({ query: '', offset: 0, limit: 3 }).rows.map(row => row.address.sessionId))
            .toEqual(['focused', 'recent', 'latest']);
    });
    it('disables only an image-refusing Session for image delivery while the ordinary modal stays selectable', () => {
        const session = createSessionFixture({ id: 'refusing', serverId: 'home-a',
            metadata: { path: '/project', host: 'machine', flavor: 'codex', name: 'Refuses images',
                agentRuntimeCapabilitiesV1: { backend: { session: { media: { acceptsImageInput: { supported: false } } } } } },
        });
        const candidate = { ...session, serverId: 'home-a' };
        expect(projectSessionSelectionRows([candidate], { requireImageInput: true })[0].disabledReason)
            .toContain("can't read images");
        expect(projectSessionSelectionRows([candidate])[0].disabledReason).toBeUndefined();
    });
    it('projects only the requested page across 1008 Sessions, 112 Machines and three Homes', () => {
        const homes = ['home-a', 'home-b', 'home-c'];
        const sessions = Array.from({ length: 1008 }, (_, index) => createSessionFixture({
            id: `session-${index}`, serverId: homes[index % homes.length],
            createdAt: 1_700_000_000_000 + index * 1000, updatedAt: 1_700_000_000_000 + index * 1000,
            meaningfulActivityAt: 1_700_000_000_000 + index * 1000,
            metadata: { path: '/project', host: `machine-${index % 112}`, machineId: `machine-${index % 112}`, name: `Task ${index}` },
        }));
        storage.setState({
            sessions: {},
            machines: Object.fromEntries(Array.from({ length: 112 }, (_, index) => {
                const machine = createMachineFixture({ id: `machine-${index}` });
                return [machine.id, machine];
            })),
            sessionListIndexByServerId: Object.fromEntries(homes.map(home => [home, sessions.filter(s => s.serverId === home)
                .map(s => ({ type: 'session' as const, sessionId: s.id, serverId: home }))])),
            sessionListRowsByServerId: Object.fromEntries(homes.map(home => [home, Object.fromEntries(sessions.filter(s => s.serverId === home)
                .map(s => [s.id, buildSessionListRenderableFromSession(s)]))])),
            ordinarySessionListMembershipByServerId: Object.fromEntries(homes.map(home => [home, sessions.filter(s => s.serverId === home).map(s => s.id)])),
        });
        // Observe the real projection work; no internal result or implementation is replaced.
        const statusReads = vi.spyOn(sessionPresentation, 'getSessionStatus');
        const page = readSessionChooserPage({ query: '', offset: 7, limit: 9 });
        expect(page.total).toBe(1008);
        expect(page.rows).toHaveLength(9);
        expect(statusReads).toHaveBeenCalledTimes(9);
        expect(page.rows[0].address.sessionId).toBe('session-1000');
        expect(page.rows.every(row => !('metadata' in row) && !('session' in row))).toBe(true);
        const filtered = readSessionChooserPage({ query: 'Task 100', offset: 0, limit: 4 });
        expect(filtered.total).toBe(9);
        expect(filtered.rows).toHaveLength(4);
        expect(statusReads).toHaveBeenCalledTimes(13);
    });
});
