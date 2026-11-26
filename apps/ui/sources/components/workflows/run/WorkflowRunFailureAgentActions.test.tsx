import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentActionButton } from '@happier-dev/plugin-ui/components';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

const execute = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>(),
    createFrontDoorActionExecute: () => execute,
}));

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { PluginSurfaceDestinationNavigationBindingProvider } =
    await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { WorkflowRunFailureAgentActions } = await import('./WorkflowRunFailureAgentActions');

const pluginId = 'happier.triage';
const localId = 'native-failure/handle-v1';
const actionId = 'workflow-investigation';
const refusal = { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' } as const;

afterEach(async () => {
    standardCleanup();
    execute.mockReset();
    await account.reset();
});

async function mountRun() {
    await account.restore({ machines: [] });
    const { serverId } = storage.getState().profileScope!;
    const subject = { kind: 'workflowRun', serverId, runId: '298d4e32-68d9-4cc8-9c8d-2253d266a176' } as const;
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId, destinationId: 'triage', rendererId: 'actions-editor', container: 'appPage', target: { kind: 'app' },
    });
    if (!binding) throw new Error('Expected the editor destination binding');
    const placement: PluginUiSurfacePlacementProjection = {
        id: 'triage', pluginId, contributionKind: 'surfacePlacement', descriptorId: 'triage',
        binding, target: binding.target, renderer: { kind: 'reactNative', contributionId: 'actions-editor' },
        display: { developerFallback: 'Triage' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [], failureActions: { action: localId },
    };
    const unpublish = publishCommittedAppShellPluginUiProjection(() => ({
        ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: { triage: placement },
    }));
    const navigation = { targetKind: 'app' as const, registerOwner: () => () => {},
        openSurface: () => ({ ok: true as const }) };
    try {
        const screen = await renderScreen(
            <AccountNoticeInvestigationBoundary>
                <PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>
                    <WorkflowRunFailureAgentActions subject={subject} testIDPrefix="failed-run" />
                </PluginSurfaceDestinationNavigationBindingProvider>
            </AccountNoticeInvestigationBoundary>,
        );
        return { screen, subject, dispose: async () => { await screen.unmount(); unpublish(); } };
    } catch (error) {
        unpublish();
        throw error;
    }
}

const catalog = (actions: readonly unknown[]) => ({ ok: true, result: { kind: 'actions', actions } });
const record = { actionId, label: 'Investigate this Run', launchMode: 'review', startable: true };

it('uses the settled catalog refusal to suppress the Investigate menu', async () => {
    execute.mockResolvedValue(refusal);
    const run = await mountRun();
    try {
        await vi.waitFor(() => expect(run.screen.findByTestId('investigation.agentActions.unavailable')).not.toBeNull());
        expect(run.screen.findAllByType(AgentActionButton)).toHaveLength(0);
        expect(execute.mock.calls).toHaveLength(1);
    } finally { await run.dispose(); }
});

it.each([['start', 'send'], ['review', 'compose']] as const)(
    'shows the localized refusal for %s through the selected investigation Action', async (mode, delivery) => {
        execute.mockResolvedValueOnce(catalog([record])).mockResolvedValueOnce(refusal);
        const run = await mountRun();
        try {
            const button = await vi.waitFor(() => {
                const button = run.screen.findAllByType(AgentActionButton)[0];
                expect(button?.props.title).toBe(record.label);
                return button!;
            });
            await act(async () => { button.props.onLaunch(mode); });
            expect(execute.mock.calls.at(-1)?.slice(0, 2)).toEqual(['action.invoke', {
                action: { pluginId, localId },
                input: { kind: 'launch', context: { kind: 'failure', subject: run.subject }, actionId, delivery },
            }]);
            expect(run.screen.findByTestId('failed-run-investigate.unavailable')).not.toBeNull();
            expect(run.screen.getTextContent()).toContain(t('pluginRuntime.actionUnavailable'));
            expect(run.screen.getTextContent()).not.toContain('Nothing was started.');
            expect(run.screen.findByTestId('failed-run-investigate.unavailable.details')).toBeNull();
        } finally { await run.dispose(); }
    },
);

it('offers Edit only for a named investigation and presents a failed editor open', async () => {
    execute.mockResolvedValueOnce(catalog([]));
    const unnamed = await mountRun();
    try {
        await vi.waitFor(() => expect(unnamed.screen.findAllByType(AgentActionButton)).toHaveLength(1));
        expect(unnamed.screen.findAllByType(AgentActionButton)[0]!.props.onEdit).toBeUndefined();
    } finally { await unnamed.dispose(); }

    execute.mockResolvedValueOnce(catalog([record])).mockResolvedValueOnce(refusal);
    const named = await mountRun();
    try {
        const button = await vi.waitFor(() => {
            const button = named.screen.findAllByType(AgentActionButton)[0];
            expect(button?.props.title).toBe(record.label);
            return button!;
        });
        await act(async () => { button.props.onEdit!(); });
        expect(execute.mock.calls.at(-1)?.slice(0, 2)).toEqual(['action.invoke', {
            action: { pluginId, localId }, input: { kind: 'edit', actionId },
        }]);
        expect(named.screen.findByTestId('failed-run-investigate.unavailable')).not.toBeNull();
    } finally { await named.dispose(); }
});
