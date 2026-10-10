import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionFixture, createSessionListRenderableSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

import { SessionLineageBreadcrumb } from './SessionLineageBreadcrumb';

describe('Session lineage navigation', () => {
    let previous: ReturnType<ReturnType<typeof getStorage>['getState']>;
    beforeEach(() => {
        previous = getStorage().getState();
        getStorage().setState({
            sessions: { lead: createSessionFixture({ id: 'lead', serverId: 'other-home', metadata: { path: '/other', host: 'other', name: 'Wrong Home' } }) },
            sessionListRowsByServerId: { 'report-home': {
                child: createSessionListRenderableSessionFixture({ id: 'child', reportsTo: { sessionId: 'lead' } }),
                lead: createSessionListRenderableSessionFixture({ id: 'lead', metadata: { path: '/repo', host: 'host', name: 'Unopened lead' }, reportsTo: { sessionId: 'root' } }),
                root: createSessionListRenderableSessionFixture({ id: 'root', metadata: { path: '/repo', host: 'host', name: 'Root' }, reportsTo: null }),
            } },
        });
    });
    afterEach(async () => { await standardCleanup(); getStorage().setState(previous, true); });

    it('offers Reports-to as one link to the unopened immediate lead in its exact Home', async () => {
        const push = vi.fn();
        const relationship = <SessionLineageBreadcrumb sessionId="child" serverId="report-home" presentation="reportsTo" />;
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="phone-work" ref={{ kind: 'session', params: { id: 'child' } }} pathname="/session/child" focused visible
                navigation={{ push, replace: () => {}, back: () => {} }}>
                {relationship}
            </DestinationInstanceHost>,
        );
        expect(screen.getTextContent()).toContain(t('sessionWork.peek.reportsTo', { lead: 'Unopened lead' }));
        expect(screen.getTextContent()).not.toContain('Root');
        const link = screen.findHostByTestId('session-header-lineage:lead');
        expect(link?.props.role ?? link?.props.accessibilityRole).toBe('link');
        await screen.pressByTestIdAsync('session-header-lineage:lead');
        expect(push).toHaveBeenCalledWith('/session/lead?serverId=report-home');
    });

    it('keeps the root-first breadcrumb and renders no relationship for a root Session', async () => {
        const screen = await renderScreen(<SessionLineageBreadcrumb sessionId="child" serverId="report-home" />);
        expect(screen.getTextContent()).toContain('Root');
        expect(screen.getTextContent()).toContain('Unopened lead');
        const root = await renderScreen(<SessionLineageBreadcrumb sessionId="root" serverId="report-home" />);
        expect(root.findHostByTestId('session-header-lineage')).toBeNull();
    });
});
