import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from '@/components/sessions/actions/sessionActionsTestHelpers';

const testState = vi.hoisted(() => ({
    session: null as Session | null,
}));

installSessionActionsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            navigation: { isFocused: () => true },
            params: () => ({ id: testState.session?.id ?? 'session-1' }),
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => testState.session,
            useIsDataReady: () => true,
        });
    },
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({ kind: 'available', sessionId }),
}));

vi.mock('@/sync/api/capabilities/sessionSharingSupport', () => ({
    isSessionSharingSupported: async () => false,
}));

vi.mock('@/components/ui/lists/Item', async () => {
    const ReactModule = await import('react');
    return {
        Item: (props: Record<string, unknown>) => ReactModule.createElement('Item', props),
    };
});
vi.mock('@/components/ui/lists/ItemGroup', async () => {
    const ReactModule = await import('react');
    return {
        ItemGroup: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    };
});
vi.mock('@/components/ui/lists/ItemList', async () => {
    const ReactModule = await import('react');
    return {
        ItemList: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
    };
});
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/ui/status/StatusDot', () => ({ StatusDot: () => null }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: () => null }));
vi.mock('@/components/ui/media/CodeView', () => ({ CodeView: () => null }));
vi.mock('@/components/sessions/info/SessionRetentionNotice', () => ({ SessionRetentionNotice: () => null }));

function createOwnedSessionWithTerminalControl(
    controlServiceabilityV1: NonNullable<NonNullable<Session['metadata']>['terminal']>['controlServiceabilityV1'],
): Session {
    return createSessionFixture({
        active: false,
        owner: 'current-user',
        accessLevel: undefined,
        presence: 123,
        metadata: {
            path: '/tmp/project',
            host: 'local',
            terminal: {
                mode: 'zellij',
                controlServiceabilityV1,
            },
        },
    });
}

describe('session info lifecycle actions', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        testState.session = null;
    });

    it.each([
        {
            name: 'recoverable preserved host while disconnected',
            controlServiceabilityV1: {
                v: 1 as const,
                attachmentId: 'attachment-recoverable',
                state: 'recoverable_unservable' as const,
                observedAt: 123,
                reason: 'control_descriptor_missing',
            },
        },
        {
            name: 'serviceable preserved host while offline with Activity unknown',
            controlServiceabilityV1: {
                v: 1 as const,
                attachmentId: 'attachment-servable',
                state: 'servable' as const,
                observedAt: 124,
            },
        },
    ])('renders Stop and stop-then-Delete for a $name', async ({ controlServiceabilityV1 }) => {
        testState.session = createOwnedSessionWithTerminalControl(controlServiceabilityV1);
        const { default: SessionInfoRoute } = await import('@/app/(app)/session/[id]/info');

        const screen = await renderScreen(<SessionInfoRoute />);

        expect(screen.findByTestId('sessionInfo.stopSession')).toBeTruthy();
        expect(screen.findByTestId('sessionInfo.deleteSession')).toBeTruthy();
    });

    it.each([
        {
            name: 'unknown preserved host',
            session: createOwnedSessionWithTerminalControl({
                v: 1,
                attachmentId: 'attachment-unknown',
                state: 'unknown',
                observedAt: 125,
                reason: 'attachment_changed',
            }),
            deleteVisible: false,
        },
        {
            name: 'missing attachment evidence',
            session: createOwnedSessionWithTerminalControl({
                v: 1,
                state: 'recoverable_unservable',
                observedAt: 126,
                reason: 'control_descriptor_missing',
            }),
            deleteVisible: false,
        },
        {
            name: 'retired attachment evidence',
            session: createOwnedSessionWithTerminalControl({
                v: 1,
                attachmentId: 'attachment-retired',
                state: 'recoverable_unservable',
                observedAt: 127,
                reason: 'attachment_retired',
                retired: true,
            }),
            deleteVisible: true,
        },
        {
            name: 'preserved host not owned by the current user',
            session: {
                ...createOwnedSessionWithTerminalControl({
                    v: 1,
                    attachmentId: 'attachment-shared',
                    state: 'recoverable_unservable',
                    observedAt: 128,
                    reason: 'control_descriptor_missing',
                }),
                owner: 'another-user',
                accessLevel: 'view' as const,
            },
            deleteVisible: false,
        },
    ])('does not expose Stop for $name', async ({ session, deleteVisible }) => {
        testState.session = session;
        const { default: SessionInfoRoute } = await import('@/app/(app)/session/[id]/info');

        const screen = await renderScreen(<SessionInfoRoute />);

        expect(screen.findByTestId('sessionInfo.stopSession')).toBeNull();
        expect(Boolean(screen.findByTestId('sessionInfo.deleteSession'))).toBe(deleteVisible);
    });
});
