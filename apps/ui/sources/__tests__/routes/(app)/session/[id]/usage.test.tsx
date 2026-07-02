import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

let mockSessionId: string | undefined = 'session-1';

const routerMock = createExpoRouterMock({
    router: {
        back: vi.fn(),
        push: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

installSessionRouteCommonModuleMocks({
    router: () => ({
        ...routerMock.module,
        useLocalSearchParams: () => ({ id: mockSessionId }),
        useGlobalSearchParams: () => ({ id: mockSessionId }),
    }),
});

vi.mock('@/components/settings/usage/UsagePanel', () => ({
    UsagePanel: (props: { sessionId?: string }) => React.createElement('UsagePanel', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string | null) =>
        sessionId
            ? { kind: 'available', sessionId }
            : { kind: 'loading', sessionId: '', reason: 'store-miss' },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

describe('/session/[id]/usage', () => {
    let Screen: React.ComponentType<any>;

    beforeAll(async () => {
        Screen = (await import('@/app/(app)/session/[id]/usage')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the shared UsagePanel scoped to the requested session', async () => {
        const screen = await renderScreen(<Screen />);
        const panel = screen.findByType('UsagePanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
    });

    it('renders the invalid session fallback when the route does not include a session id', async () => {
        mockSessionId = undefined;
        const screen = await renderScreen(<Screen />);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
    });
});
