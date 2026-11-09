import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
beforeAll(loadSyncSingletonForTests);
const { WorkflowsGate } = await import('./WorkflowsGate');

let serverId: string;
beforeEach(async () => {
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    getStorage().setState({ settings: { ...settingsDefaults, experiments: false }, settingsScope: null });
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    serverId = await homes.addHome({ name: 'Workflow Home', serverUrl: 'https://workflow-gate.example', accountId: 'gate-account' });
});

afterEach(() => {
    standardCleanup();
    routerPush.mockReset();
    vi.restoreAllMocks();
});

async function publishFeatures(workflows: boolean, automations = true) {
    const features = createRootLayoutFeaturesResponse({ features: {
        workflows: { enabled: workflows }, automations: { enabled: automations },
    } });
    homes.answer(serverId, '/v1/features', { body: features });
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    return getServerFeaturesSnapshot({ serverId, force: true });
}

async function renderGate(surface?: 'destination') {
    return (await renderScreen(
        <WorkflowsGate {...(surface ? { surface } : {})}><Allowed /></WorkflowsGate>,
    )).tree;
}

describe('WorkflowsGate', () => {
    it('refuses an occurrence when Workflows is disabled even if the released alias is enabled', async () => {
        await publishFeatures(false, true);
        const screen = await renderScreen(<WorkflowsGate surface="occurrence"><Allowed /></WorkflowsGate>);
        expect(screen.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
        expect(screen.findByTestId('workflows-gate-disabled')).not.toBeNull();
    });
    it('fails closed while the decisions are unresolved', async () => {
        const response = createDeferred<void>();
        homes.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse(), respondAfter: response.promise });
        try {
            const tree = await renderGate();
            expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
            expect(tree.root.findByProps({ testID: 'workflows-gate-loading' }).props).toMatchObject({
                kind: 'loading',
                accessibilitySemantics: 'status',
            });
        } finally {
            await act(async () => { response.resolve(); await response.promise; });
        }
    });

    it('renders children only for the enabled Workflows decision', async () => {
        await publishFeatures(true);
        const tree = await renderGate();

        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(1);
    });

    /**
     * Showing last-known data while refreshing: a decision that re-resolves (its snapshot reloading
     * under a slow or briefly offline server) must not unmount an open editor or Run, which would
     * drop its document, pane and tab for a full-page loading state.
     */
    it('keeps an admitted destination mounted while its decision re-resolves', async () => {
        await publishFeatures(true);
        const tree = await renderGate();
        const child = tree.root.findByProps({ testID: 'workflows-allowed-child' });

        const { deleteServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await act(async () => { deleteServerFeaturesSnapshot({ serverId }); });

        expect(tree.root.findAllByProps({ testID: 'workflows-gate-loading' })).toHaveLength(0);
        // The same mounted child, not a remount.
        expect(tree.root.findByProps({ testID: 'workflows-allowed-child' })).toBe(child);
    });

    it('does not carry an admitted destination into a different unresolved Home', async () => {
        await publishFeatures(true);
        const tree = await renderGate();
        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(1);
        const response = createDeferred<void>();
        let nextServerId = '';
        await act(async () => {
            nextServerId = await homes.addHome({
                name: 'Unresolved Home', serverUrl: 'https://workflow-gate-next.example',
                accountId: 'next-account', active: false,
            });
            homes.answer(nextServerId, '/v1/features', {
                body: createRootLayoutFeaturesResponse(), respondAfter: response.promise,
            });
        });
        try {
            const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
            await act(async () => { await setActiveServerId(nextServerId, { scope: 'device' }); });
            expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
            expect(tree.root.findByProps({ testID: 'workflows-gate-loading' }).props.kind).toBe('loading');
        } finally {
            await act(async () => { response.resolve(); await response.promise; });
        }
    });

    /**
     * An unavailable capability is not a failed read: the canonical Workflow problem mapping owns the
     * copy and its (absent) repair, so no retry is offered that could never succeed.
     */
    it('states Workflows are unavailable on a hard server denial, with no repair', async () => {
        await publishFeatures(false, false);
        const tree = await renderGate();

        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
        const unavailable = tree.root.findByProps({ testID: 'workflows-gate-disabled' });
        expect(unavailable.props).toMatchObject({
            kind: 'unavailable',
            title: 'workflows.unavailable.title',
            reason: 'workflows.unavailable.body',
        });
        expect(unavailable.props.action).toBeUndefined();
    });

    it('leads a local disablement to the Workflows switch that repairs it', async () => {
        await publishFeatures(true);
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(state => ({ settings: { ...state.settings, featureToggles: { automations: false } } }));
        const tree = await renderGate();

        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
        const local = tree.root.findByProps({ testID: 'workflows-gate-local' });
        expect(local.props).toMatchObject({
            title: 'workflows.destination.gate.dependencyTitle',
            reason: 'workflows.destination.gate.dependencyBody',
        });
        local.props.action.onPress();
        expect(routerPush).toHaveBeenCalledWith('/settings/features?setting=features.workflows');
    });

    it('offers the destination repair on the home that also governs triggers', async () => {
        await publishFeatures(true);
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().setState(state => ({ settings: { ...state.settings, featureToggles: { automations: false } } }));
        const tree = await renderGate('destination');

        expect(tree.root.findByProps({ testID: 'workflows-gate-local' }).props).toMatchObject({
            title: 'workflows.destination.gate.localTitle',
            reason: 'workflows.destination.gate.localBody',
        });
    });
});

function Allowed(): React.ReactElement {
    return React.createElement('Text', { testID: 'workflows-allowed-child' }, 'Allowed');
}
