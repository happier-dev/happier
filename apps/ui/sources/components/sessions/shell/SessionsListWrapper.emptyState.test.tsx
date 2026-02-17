import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
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
    StyleSheet: { create: (factory: any) => factory({ colors: { groupped: { background: '#fff' } } }) },
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => sessionListState.data,
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));

vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: 'SessionsList',
}));

describe('SessionsListWrapper (empty state)', () => {
    beforeEach(() => {
        sessionListState.data = [];
    });

    it('renders getting started guidance when there are no sessions', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionsListWrapper />);
        });

        expect(() => tree!.root.findByType('SessionGettingStartedGuidance')).not.toThrow();
    });
});
