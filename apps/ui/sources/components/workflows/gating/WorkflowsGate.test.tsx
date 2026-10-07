import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

type Decision = Readonly<{ state: string; blockedBy: string | null; blockingDependencyId?: string }> | null;
const decisions = vi.hoisted(() => ({ workflows: null as Decision, automations: null as Decision }));
const routerPush = vi.hoisted(() => vi.fn());

// Decisions keep their identity across renders, as the real owner's do.
const decisionCache = vi.hoisted(() => new Map<unknown, unknown>());
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: 'workflows' | 'automations') => {
        const decision = decisions[featureId];
        if (decision === null) return null;
        if (!decisionCache.has(decision)) {
            decisionCache.set(decision, {
                featureId,
                blockerCode: decision.state === 'enabled' ? 'none' : 'feature_disabled',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'runtime' },
                ...decision,
            });
        }
        return decisionCache.get(decision);
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useSetting: () => false });
});

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

vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/surfaces/SurfaceStateCard', () => ({
    SurfaceStateCard: (props: Record<string, unknown>) => React.createElement('SurfaceStateCard', props),
}));

afterEach(() => {
    decisions.workflows = null;
    decisions.automations = null;
    routerPush.mockReset();
});

async function renderGate(surface?: 'destination') {
    const { WorkflowsGate } = await import('./WorkflowsGate');
    return (await renderScreen(
        <WorkflowsGate {...(surface ? { surface } : {})}><Allowed /></WorkflowsGate>,
    )).tree;
}

describe('WorkflowsGate', () => {
    it('fails closed while the decisions are unresolved', async () => {
        decisions.automations = { state: 'enabled', blockedBy: null };
        const tree = await renderGate();

        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
        expect(tree.root.findByProps({ testID: 'workflows-gate-loading' }).props).toMatchObject({
            kind: 'loading',
            accessibilitySemantics: 'status',
        });
    });

    it('renders children only for the enabled Workflows decision', async () => {
        decisions.workflows = { state: 'enabled', blockedBy: null };
        decisions.automations = { state: 'enabled', blockedBy: null };
        const tree = await renderGate();

        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(1);
    });

    /**
     * Showing last-known data while refreshing: a decision that re-resolves (its snapshot reloading
     * under a slow or briefly offline server) must not unmount an open editor or Run, which would
     * drop its document, pane and tab for a full-page loading state.
     */
    it('keeps an admitted destination mounted while its decision re-resolves', async () => {
        decisions.workflows = { state: 'enabled', blockedBy: null };
        decisions.automations = { state: 'enabled', blockedBy: null };
        const { WorkflowsGate } = await import('./WorkflowsGate');
        const tree = await renderGate();
        const child = tree.root.findByProps({ testID: 'workflows-allowed-child' });

        decisions.workflows = null;
        decisions.automations = null;
        const { act } = await import('react-test-renderer');
        await act(async () => { tree.update(<WorkflowsGate><Allowed /></WorkflowsGate>); });

        expect(tree.root.findAllByProps({ testID: 'workflows-gate-loading' })).toHaveLength(0);
        // The same mounted child, not a remount.
        expect(tree.root.findByProps({ testID: 'workflows-allowed-child' })).toBe(child);
    });

    /**
     * An unavailable capability is not a failed read: the canonical Workflow problem mapping owns the
     * copy and its (absent) repair, so no retry is offered that could never succeed.
     */
    it('states Workflows are unavailable on a hard server denial, with no repair', async () => {
        decisions.workflows = { state: 'disabled', blockedBy: 'server' };
        decisions.automations = { state: 'disabled', blockedBy: 'server' };
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

    it('leads a local disablement to the Automations switch that repairs it', async () => {
        decisions.workflows = { state: 'disabled', blockedBy: 'dependency', blockingDependencyId: 'automations' };
        decisions.automations = { state: 'disabled', blockedBy: 'local_policy' };
        const tree = await renderGate();

        expect(tree.root.findAllByProps({ testID: 'workflows-allowed-child' })).toHaveLength(0);
        const local = tree.root.findByProps({ testID: 'workflows-gate-local' });
        expect(local.props).toMatchObject({
            title: 'workflows.destination.gate.dependencyTitle',
            reason: 'workflows.destination.gate.dependencyBody',
        });
        local.props.action.onPress();
        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('/settings/features'));
    });

    it('speaks of Automations on the destination home, which also governs triggers', async () => {
        decisions.workflows = { state: 'disabled', blockedBy: 'dependency', blockingDependencyId: 'automations' };
        decisions.automations = { state: 'disabled', blockedBy: 'local_policy' };
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
