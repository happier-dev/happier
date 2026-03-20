import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsListWrapper } from './SessionsListWrapper';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
    storageKinds: [] as string[],
}));

const featureDecisionState = vi.hoisted(() => ({
    enabled: false,
}));

const storageKindState = vi.hoisted(() => ({
    storageKind: 'persisted' as 'persisted' | 'direct',
    setStorageKind: vi.fn(),
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { textSecondary: '#777', groupped: { background: '#fff' } } },
    }),
    StyleSheet: {
        create: (factory: any) =>
            typeof factory === 'function'
                ? factory({ colors: { groupped: { background: '#fff' } } })
                : factory,
    },
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: (storageKind?: string) => {
        sessionListState.storageKinds.push(storageKind ?? 'all');
        return sessionListState.data;
    },
}));

vi.mock('@/components/sessions/model/useSessionListStorageKind', () => ({
    useSessionListStorageKind: () => ({
        directSessionsEnabled: featureDecisionState.enabled,
        storageKind: featureDecisionState.enabled ? storageKindState.storageKind : 'persisted',
        setStorageKind: storageKindState.setStorageKind,
    }),
}));

vi.mock('@/components/sessions/shell/SessionsListStorageChrome', () => ({
    SessionsListStorageChrome: (props: any) => React.createElement('SessionsListStorageChrome', props),
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: (props: any) => React.createElement('SessionsList', props),
}));

describe('SessionsListWrapper (empty state)', () => {
    beforeEach(() => {
        sessionListState.data = [];
        sessionListState.storageKinds = [];
        featureDecisionState.enabled = false;
        storageKindState.storageKind = 'persisted';
        storageKindState.setStorageKind.mockReset();
    });

    it('renders getting started guidance when there are no sessions', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionsListWrapper />);
        });

        expect(() => tree!.root.findByType('SessionGettingStartedGuidance')).not.toThrow();
    });

    it('uses the persisted storage filter when direct sessions are disabled', async () => {
        act(() => {
            renderer.create(<SessionsListWrapper />);
        });

        expect(sessionListState.storageKinds).toEqual(['persisted']);
    });

    it('shows storage tabs and uses the selected direct storage filter when direct sessions are enabled', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionsListWrapper />);
        });

        expect(sessionListState.storageKinds).toEqual(['direct']);
        expect(() => tree!.root.findByType('SessionsListStorageChrome')).not.toThrow();
        expect(tree!.root.findByType('SessionsListStorageChrome').props.storageKind).toBe('direct');
        expect(tree!.root.findByType('SessionsList').props.storageKind).toBe('direct');
    });

    it('keeps the storage chrome visible in the direct empty state', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [];

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionsListWrapper />);
        });

        expect(() => tree!.root.findByType('SessionsListStorageChrome')).not.toThrow();
        expect(tree!.root.findByType('SessionsListStorageChrome').props.storageKind).toBe('direct');
    });

    it('keeps the storage chrome visible when the direct tab already has sessions', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionsListWrapper />);
        });

        expect(() => tree!.root.findByType('SessionsListStorageChrome')).not.toThrow();
        expect(tree!.root.findByType('SessionsListStorageChrome').props.storageKind).toBe('direct');
        expect(tree!.root.findByType('SessionsList').props.storageKind).toBe('direct');
    });
});
