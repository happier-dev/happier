/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';

const route = vi.hoisted(() => ({ render: undefined as (() => React.ReactNode) | undefined }));

// Expo owns the native route outlet; the rendered route uses the real investigation hook and Account owner.
vi.mock('expo-router', async () => {
    const React = await import('react');
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const { module } = createExpoRouterMock({ pathname: () => '/desktop/window', segments: () => ['desktop', 'window'] });
    const Stack = Object.assign(() => React.createElement(React.Fragment, null, route.render?.()), { Screen: module.Stack.Screen });
    return { ...module, Stack };
});

const { SidebarNavigator } = await import('./SidebarNavigator');

afterEach(() => {
    standardCleanup();
    route.render = undefined;
    vi.unstubAllGlobals();
});

describe('SidebarNavigator dedicated destination', () => {
    it('renders a service failure route with its real Account investigation owner', async () => {
        window.history.replaceState({}, '', '/desktop/window');
        vi.stubGlobal('isTauri', true);
        function ServiceFailureRoute() {
            const investigation = useInvestigateFailure({ kind: 'service', target: {
                kind: 'host', page: 'machine_service', machine: { serverId: 'home', machineId: 'machine' },
                service: { kind: 'adopted', machineId: 'machine', serviceId: 'opaque-service', watchId: 'watch', watchRevision: 'revision' },
            } });
            return React.createElement('Text', { testID: 'destination-service-investigation' }, investigation.pending ? 'pending' : 'ready');
        }
        route.render = () => <ServiceFailureRoute />;

        const screen = await renderScreen(<SidebarNavigator />);
        expect(screen.findByTestId('destination-service-investigation')?.props.children).toBe('ready');
    });
});
