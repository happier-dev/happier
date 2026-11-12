import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { Redirect } from 'expo-router';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const routerMock = vi.hoisted(() => ({ params: { id: 'session-1', serverId: 'server-a' } }));

vi.mock('expo-router', async () => createExpoRouterMock({ params: routerMock.params }).module);

// Load the real route graph as fixture setup, outside each redirect assertion's test budget.
const [automations, automationNew, automationTurnFinished] = await Promise.all([
    import('@/app/(app)/session/[id]/automations'),
    import('@/app/(app)/session/[id]/automations/new'),
    import('@/app/(app)/session/[id]/automations/when-turn-finishes'),
]);

describe('retired session automations routes', () => {
    afterEach(async () => {
        await standardCleanup();
    });

    it.each([
        ['@/app/(app)/session/[id]/automations', automations.WorkspaceRouteBody],
        ['@/app/(app)/session/[id]/automations/new', automationNew.WorkspaceRouteBody],
        ['@/app/(app)/session/[id]/automations/when-turn-finishes', automationTurnFinished.WorkspaceRouteBody],
    ])('%s lands on the session Triggers section, keeping its Home', async (_route, WorkspaceRouteBody) => {
        const screen = await renderScreen(<WorkspaceRouteBody />);
        const redirect = screen.findAllByType(Redirect)[0];
        expect(redirect?.props.href).toEqual({ pathname: '/session/[id]/triggers', params: { id: 'session-1', serverId: 'server-a' } });
    });
});
