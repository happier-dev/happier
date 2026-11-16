import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react';
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
                child: createSessionListRenderableSessionFixture({ id: 'child', manager: { sessionId: 'lead' } }),
                lead: createSessionListRenderableSessionFixture({ id: 'lead', metadata: { path: '/repo', host: 'host', name: 'Unopened lead' }, manager: { sessionId: 'root' } }),
                root: createSessionListRenderableSessionFixture({ id: 'root', metadata: { path: '/repo', host: 'host', name: 'Root' }, manager: null }),
            } },
        });
    });
    afterEach(async () => { await standardCleanup(); getStorage().setState(previous, true); });

    it('offers Reports-to as one link to the unopened immediate lead in its exact Home', async () => {
        const push = vi.fn();
        const relationship = <SessionLineageBreadcrumb sessionId="child" serverId="report-home" presentation="manager" />;
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="phone-work" ref={{ kind: 'session', params: { id: 'child' } }} pathname="/session/child" focused visible
                navigation={{ push, replace: () => {}, back: () => {} }}>
                {relationship}
            </DestinationInstanceHost>,
        );
        expect(screen.getTextContent()).toContain(t('sessionWork.peek.manager', { lead: 'Unopened lead' }));
        expect(screen.getTextContent()).not.toContain('Root');
        const link = screen.findHostByTestId('session-header-lineage:lead');
        expect(link?.props.role ?? link?.props.accessibilityRole).toBe('link');
        await screen.pressByTestIdAsync('session-header-lineage:lead');
        expect(push).toHaveBeenCalledWith('/session/lead?serverId=report-home');
    });

    it('draws the Reports-to row at its text line and gives the finger its reach through the hit area', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <DestinationInstanceHost tabId="phone-work" ref={{ kind: 'session', params: { id: 'child' } }} pathname="/session/child" focused visible
                    navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionLineageBreadcrumb sessionId="child" serverId="report-home" presentation="manager" />
                </DestinationInstanceHost>
            </HappierUiPlatformProvider>,
        );
        const link = screen.findHostByTestId('session-header-lineage:lead')!;
        await act(async () => { link.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 16 } } }); });
        const drawn = [link.props.style].flat(Infinity).filter(Boolean).reduce((all, one) => ({ ...all, ...one }), {} as Record<string, unknown>);
        expect(drawn.minHeight).toBeUndefined();
        const frame = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0]!;
        // The header title sits flush above the row (owner 11-15): the row's hit area keeps its lower side only.
        expect(frame.props.style.top).toBeCloseTo(0);
        expect(frame.props.style.bottom).toBeLessThan(0);
    });

    it('keeps the root-first breadcrumb and renders no relationship for a root Session', async () => {
        const screen = await renderScreen(<SessionLineageBreadcrumb sessionId="child" serverId="report-home" />);
        expect(screen.getTextContent()).toContain('Root');
        expect(screen.getTextContent()).toContain('Unopened lead');
        const root = await renderScreen(<SessionLineageBreadcrumb sessionId="root" serverId="report-home" />);
        expect(root.findHostByTestId('session-header-lineage')).toBeNull();
    });
});
