import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';
import { AutomationsGate } from './AutomationsGate';

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);
installDisconnectedServerSocketBoundary();
installAutomationComponentCommonModuleMocks();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousState = storage.getState();
let featureResponse = createRootLayoutFeaturesResponse();
let pendingFeatures: ReturnType<typeof createDeferred<Response>> | null = null;
const featureRequests: string[] = [];
function primeReady() {
    primeServerFeaturesSnapshot({ serverId: connection.home.id, snapshot: { status: 'ready', features: featureResponse } });
}
beforeEach(async () => {
    previousState = storage.getState();
    resetServerFeaturesClientForTests();
    featureRequests.length = 0;
    pendingFeatures = null;
    featureResponse = createRootLayoutFeaturesResponse();
    await loadSyncSingletonForTests();
    connection = await restoreServerAccountForTest({ serverUrl: 'https://automations-gate.test', accountId: 'gate-account',
        request: async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                featureRequests.push(path);
                return pendingFeatures?.promise ?? Response.json(featureResponse);
            }
            if (path === '/health') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    storage.setState({ settings: { ...storage.getState().settings, experiments: true,
        featureToggles: { ...storage.getState().settings.featureToggles, automations: true } } });
    primeReady();
});
afterEach(async () => {
    standardCleanup();
    pendingFeatures?.resolve(Response.json(featureResponse));
    await connection.dispose();
    resetServerFeaturesClientForTests();
    storage.setState(previousState);
    routerPush.mockClear();
});
function allowed() { return <AutomationsGate><TextStub>Allowed</TextStub></AutomationsGate>; }
function TextStub(props: { children: string }) {
    return React.createElement('Text', { ...props, testID: 'automations-allowed-child' });
}

describe('AutomationsGate', () => {
    it('renders a loading state while automations support is unresolved', async () => {
        pendingFeatures = createDeferred<Response>();
        resetServerFeaturesClientForTests();
        const screen = await renderScreen(allowed());
        expect(screen.findByTestId('automations-allowed-child')).toBeNull();
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' }).length).toBeGreaterThan(0);
        pendingFeatures.resolve(Response.json(featureResponse));
        await vi.waitFor(() => expect(screen.findByTestId('automations-allowed-child')).not.toBeNull());
    });
    it('renders children when automations are enabled', async () => {
        const screen = await renderScreen(allowed());
        expect(screen.findByTestId('automations-allowed-child')).not.toBeNull();
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        expect(screen.findByTestId('automations-gate-disabled')).toBeNull();
    });
    it('renders a disabled state when automations are unavailable', async () => {
        featureResponse = createRootLayoutFeaturesResponse({ features: { automations: { enabled: false } } });
        primeReady();
        const screen = await renderScreen(allowed());
        expect(screen.findByTestId('automations-allowed-child')).toBeNull();
        expect(screen.findByTestId('automations-gate-disabled')).not.toBeNull();
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
    });
});
describe('AutomationsGate next action', () => {
    it.each([true, false])('links a setting-blocked state to the Features toggle that turns it on (experiments %s)', async (experiments) => {
        storage.setState({ settings: { ...storage.getState().settings, experiments,
            featureToggles: { ...storage.getState().settings.featureToggles, automations: false } } });
        const screen = await renderScreen(allowed());
        await screen.pressByTestIdAsync('automations-gate-disabled-action');
        expect(routerPush).toHaveBeenCalledWith('/settings/features?setting=features.automations');
    });
    it('says the Home turned automations off, and offers no link, when the server blocks them', async () => {
        featureResponse = createRootLayoutFeaturesResponse({ features: { automations: { enabled: false } } });
        primeReady();
        const screen = await renderScreen(allowed());
        expect(screen.findByTestId('automations-gate-disabled-action')).toBeNull();
        expect(screen.findByTestId('automations-gate-disabled-title')?.props.children).toBe('automationPages.gate.serverTitle');
        expect(screen.findByTestId('automations-gate-disabled-reason')?.props.children).toBe('automationPages.gate.serverBody');
    });
});
describe('AutomationsGate availability truth', () => {
    it('does not claim administrators turned automations off when the Home could not be checked, and retries the probe', async () => {
        primeServerFeaturesSnapshot({ serverId: connection.home.id, snapshot: { status: 'error', reason: 'network' } });
        const screen = await renderScreen(allowed());
        expect(screen.findByTestId('automations-gate-unknown-title')?.props.children).toBe('automationPages.gate.unknownTitle');
        expect(screen.findAllByProps({ title: 'automationPages.gate.serverTitle' })).toHaveLength(0);
        const readsBeforeRetry = featureRequests.length;
        await screen.pressByTestIdAsync('automations-gate-unknown-action');
        expect(featureRequests.length).toBeGreaterThan(readsBeforeRetry);
        await vi.waitFor(() => expect(screen.findByTestId('automations-allowed-child')).not.toBeNull());
    });
    it('says the Home does not support automations yet when its server predates them', async () => {
        primeServerFeaturesSnapshot({ serverId: connection.home.id, snapshot: { status: 'unsupported', reason: 'endpoint_missing' } });
        const screen = await renderScreen(allowed());
        expect(screen.findByTestId('automations-gate-unsupported-title')?.props.children).toBe('automationPages.gate.unsupportedTitle');
        expect(screen.findByTestId('automations-gate-unsupported-reason')?.props.children).toBe('automationPages.gate.unsupportedBody');
        expect(screen.findByTestId('automations-gate-unsupported-action')).toBeNull();
        expect(screen.findAllByProps({ title: 'automationPages.gate.serverTitle' })).toHaveLength(0);
    });
});
