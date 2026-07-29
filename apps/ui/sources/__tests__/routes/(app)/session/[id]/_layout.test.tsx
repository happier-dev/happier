import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const routeParams = vi.hoisted(() => ({
    value: { id: 'session-1' } as Readonly<{ id?: string }>,
}));
const sessionState = vi.hoisted(() => ({
    current: null as Readonly<{
        id: string;
        active: boolean;
        metadata: unknown;
        ownerMetadataView?: unknown;
        metadataLayoutVersion?: number;
    }> | null,
}));

vi.mock('expo-router', () => ({
    Slot: () => React.createElement('SessionRouteSlot'),
    useLocalSearchParams: () => routeParams.value,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionState.current,
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

describe('ordinary session route layout', () => {
    afterEach(() => {
        standardCleanup();
        routeParams.value = { id: 'session-1' };
        sessionState.current = null;
    });

    it('does not mount ordinary session routes for the hidden Voice transcript history carrier', async () => {
        sessionState.current = {
            id: 'session-1',
            active: false,
            metadata: {
                systemSessionV1: {
                    v: 1,
                    key: 'voice_transcript_history',
                    hidden: true,
                },
            },
        };
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(React.createElement(Layout.default));

        expect(screen.findAllByType('SessionInvalidLinkFallback')).toHaveLength(1);
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(0);
    });

    it('keeps ordinary user sessions routed normally', async () => {
        sessionState.current = {
            id: 'session-1',
            active: false,
            metadata: {
                summary: {
                    text: 'Ordinary coding session',
                    updatedAt: 1,
                },
            },
        };
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(React.createElement(Layout.default));

        expect(screen.findAllByType('SessionInvalidLinkFallback')).toHaveLength(0);
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(1);
    });
});
