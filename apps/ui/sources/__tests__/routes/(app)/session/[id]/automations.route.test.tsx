import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { Redirect } from 'expo-router';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const routerMock = vi.hoisted(() => ({ params: { id: 'session-1', serverId: 'server-a' } }));

vi.mock('expo-router', async () => createExpoRouterMock({ params: routerMock.params }).module);

describe('retired session automations routes', () => {
    afterEach(async () => {
        await standardCleanup();
    });

    it.each([
        ['@/app/(app)/session/[id]/automations'],
        ['@/app/(app)/session/[id]/automations/new'],
        ['@/app/(app)/session/[id]/automations/when-turn-finishes'],
    ])('%s lands on the session Triggers section, keeping its Home', async (route) => {
        const { WorkspaceRouteBody } = await import(/* @vite-ignore */ route);
        const screen = await renderScreen(<WorkspaceRouteBody />);
        const redirect = screen.findAllByType(Redirect)[0];
        expect(redirect?.props.href).toEqual({ pathname: '/session/[id]/triggers', params: { id: 'session-1', serverId: 'server-a' } });
    });
});
