import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const automationsScreenSpy = vi.hoisted(() => vi.fn());
const createScreenSpy = vi.hoisted(() => vi.fn());

const routerMock = createExpoRouterMock({
    params: { id: ['s1', 's2'] },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/components/automations/gating/AutomationsGate', () => ({
    AutomationsGate: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/automations/screens/SessionAutomationsScreen', () => ({
    SessionAutomationsScreen: (props: { sessionId: string }) => automationsScreenSpy(props),
}));

vi.mock('@/components/automations/screens/SessionAutomationCreateScreen', () => ({
    SessionAutomationCreateScreen: (props: { sessionId: string }) => createScreenSpy(props),
}));

describe('session automations routes', () => {
    beforeEach(() => {
        automationsScreenSpy.mockClear();
        createScreenSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before rendering the automations screen', async () => {
        const { default: AutomationsRoute } = await import('@/app/(app)/session/[id]/automations');

        await renderScreen(<AutomationsRoute />);

        expect(automationsScreenSpy).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('normalizes array session ids before rendering the create screen', async () => {
        const { default: CreateRoute } = await import('@/app/(app)/session/[id]/automations/new');

        await renderScreen(<CreateRoute />);

        expect(createScreenSpy).toHaveBeenCalledWith({ sessionId: 's1' });
    });
});
