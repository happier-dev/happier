import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionsListWrapper } from './SessionsListWrapper';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

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

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                textSecondary: '#777',
                groupped: { background: '#fff' },
            },
        });
    },
});
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

    afterEach(() => {
        standardCleanup();
    });

    it('renders getting started guidance when there are no sessions', async () => {
        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).not.toThrow();

        await screen.unmount();
    });

    it('uses the persisted storage filter when direct sessions are disabled', async () => {
        const screen = await renderScreen(<SessionsListWrapper />);

        expect(sessionListState.storageKinds).toEqual(['persisted']);

        await screen.unmount();
    });

    it('shows storage tabs and uses the selected direct storage filter when direct sessions are enabled', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(sessionListState.storageKinds).toEqual(['direct']);
        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsList' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });

    it('keeps the storage chrome visible in the direct empty state', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });

    it('keeps the storage chrome visible when the direct tab already has sessions', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsList' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });
});
