import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeParams = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('expo-router', async () => {
    const mock = createExpoRouterMock({ params: {} });
    return { ...mock.module, useLocalSearchParams: () => routeParams.current, useGlobalSearchParams: () => routeParams.current };
});

async function redirectFor(params: Record<string, unknown>) {
    routeParams.current = params;
    const { WorkspaceRouteBody } = await import('@/app/(app)/automations/new');
    const screen = await renderScreen(<WorkspaceRouteBody />);
    return screen.findAll((node) => String(node.type) === 'Redirect')[0]?.props.href;
}

/** There is no Automation create surface any more (FIN 03 §8.2): every old link lands where triggers live. */
describe('retired /automations/new', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('sends an exact-turn link to that session\'s Triggers section', async () => {
        expect(await redirectFor({ sourceSessionId: 'session-1', sourceTurnId: 'turn-1', sourceServerId: 'server-a' }))
            .toEqual({ pathname: '/session/[id]/triggers', params: { id: 'session-1', serverId: 'server-a',
                sourceSessionId: 'session-1', sourceTurnId: 'turn-1', sourceServerId: 'server-a' } });
    });

    it('opens a New Session handoff in the workflow editor', async () => {
        expect(await redirectFor({ newSessionDraftSeedId: 'seed-1' }))
            .toEqual({ pathname: '/workflows/new', params: { newSessionDraftSeedId: 'seed-1' } });
    });

    it('opens Workflows for anything else, including a retired Schedule seed', async () => {
        expect(await redirectFor({ workflowSeedId: 'seed-2' })).toBe('/workflows');
    });
});
