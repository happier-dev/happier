import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Platform rendering/navigation, HTTP persistence and Socket transport are the boundaries.
installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
const account = createProviderSettingsAccountHarness();
const { PendingPluginChangesSection } = await import('./PluginMarketplaceSections');
const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { buildApprovalHref } = await import('@/components/approvals/approvalNavigation');

async function prepareApproval(machineId = 'machine-a', summary = 'Install reviewed plugin') {
    const actionId = 'plugins.install';
    const actionArgs = { machineId, kind: 'path', path: '/workspace/reviewed-plugin' };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId, actionArgs,
        executionOriginV1: buildApprovalExecutionOriginV1({ actionId, input: actionArgs, targetSessionId: null,
            context: { surface: 'agent', authority: 'account_automation', serverId: account.serverId,
                runtimeAccountId: 'account-a', executionRunTargetMachineId: machineId,
                actionRequestId: `install-${machineId}`, actionCaller: { kind: 'host' } } }),
        summary });
    const context = await captureActionAccountContext(account.serverId);
    try { return await context.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
    finally { context.dispose(); }
}

describe('Pending plugin changes', () => {
    beforeEach(async () => {
        await account.restore({ currentAccount: true,
            machines: [createMachineFixture({ id: 'machine-a' }), createMachineFixture({ id: 'machine-b' })] });
    });
    afterEach(async () => { await standardCleanup(); await account.reset(); });

    it('opens the exact ordinary approval, withdraws the old Machine row and settles only through Inbox', async () => {
        const artifactId = await prepareApproval();
        let workspace = createWorkspaceState({ id: 'plugins', target: { kind: 'settings', params: { path: 'plugins' } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: false, friends: false }, pages: [] });
        const commit = vi.fn();
        let id = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => workspace, getCatalog: () => catalog,
            dispatch: action => { workspace = reduceWorkspaceState(workspace, action); }, transport: { commit },
            createId: () => `tab-${++id}`, onChange: () => {} });
        const adapter = createWorkspaceActionAdapter({ getState: () => workspace, navigation, readCanvas: () => null,
            createId: () => `tab-${++id}` });
        const retire = registerMountedWorkspaceAction(async ({ actionId, input }) => adapter(actionId, input));
        const target = (machineId: string) => ({ serverId: account.serverId, machineId });
        const view = (machineId: string) => <PendingPluginChangesSection active target={target(machineId)} pendingChanges={[]} />;
        const screen = await renderScreen(view('machine-a'));
        try {
            const reviewId = `settings.plugins.management.pendingChanges.${artifactId}.action.review`;
            await waitForHomeGovernance(() => expect(screen.findByTestId(reviewId)).not.toBeNull());
            expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${artifactId}.action.reject`)).toBeNull();
            const retainedReview = screen.findAllByTestId(reviewId).find(node => typeof node.props.onPress === 'function')!.props.onPress;
            await screen.pressByTestIdAsync(reviewId);
            await waitForHomeGovernance(() => expect(commit).toHaveBeenCalled());
            expect(commit.mock.calls.at(-1)?.[0]).toBe(buildApprovalHref(artifactId, account.serverId));
            const stored = account.home.artifacts(account.serverId).readPlainBody(artifactId);
            expect(ApprovalRequestV2Schema.parse(JSON.parse(stored!))).toMatchObject({ status: 'open', actionArgs: {
                machineId: 'machine-a', path: '/workspace/reviewed-plugin' } });
            await screen.update(view('machine-b'));
            expect(screen.findByTestId(reviewId)).toBeNull();
            const opens = commit.mock.calls.length;
            await act(async () => { await retainedReview(); });
            expect(commit).toHaveBeenCalledTimes(opens);
            expect(account.home.artifacts(account.serverId).readPlainBody(artifactId)).toBe(stored);
            expect(await decideApprovalAsInbox(account.serverId, artifactId, 'reject')).toMatchObject({ ok: true });
            await screen.update(view('machine-a'));
            await waitForHomeGovernance(() => expect(screen.findByTestId(reviewId)).toBeNull());
            expect(ApprovalRequestV2Schema.parse(JSON.parse(account.home.artifacts(account.serverId).readPlainBody(artifactId)!)).status).toBe('rejected');
            expect(account.home.requestsFor('/v1/actions/plugins.install')).toHaveLength(0);
        } finally { retire(); await screen.unmount(); }
    });

    it('names each waiting install by what it installs, through the approval title owner', async () => {
        await prepareApproval('machine-a', 'Install plugin.');
        const target = { serverId: account.serverId, machineId: 'machine-a' };
        const screen = await renderScreen(<PendingPluginChangesSection active target={target} pendingChanges={[]} />);
        try {
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('reviewed-plugin'));
            expect(screen.getTextContent()).not.toContain('Install plugin.');
        } finally { await screen.unmount(); }
    });

    it('keeps hidden management idle and renders applying only from the daemon listing', async () => {
        const before = account.home.requests.length;
        const target = { serverId: account.serverId, machineId: 'machine-a' };
        const screen = await renderScreen(<PendingPluginChangesSection active={false} target={target} pendingChanges={[]} />);
        expect(account.home.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'))).toHaveLength(0);
        await screen.update(<PendingPluginChangesSection active target={target} pendingChanges={[{ kind: 'applying', pendingChangeId: 'daemon-change' }]} />);
        expect(screen.getTextContent()).toContain('settingsPlugins.pendingChangeApplying');
        expect(screen.findByTestId('settings.plugins.management.pendingChanges.daemon-change.action.review')).toBeNull();
        await screen.update(<PendingPluginChangesSection active target={target} pendingChanges={[]} />);
        expect(screen.getTextContent()).not.toContain('settingsPlugins.pendingChangeApplying');
        await screen.update(<PendingPluginChangesSection active target={{ serverId: 'foreign-home', machineId: 'machine-a' }}
            pendingChanges={[{ kind: 'applying', pendingChangeId: 'daemon-change' }]} />);
        expect(screen.findByTestId('settings.plugins.management.pendingChanges.approvalsUnavailable')).toBeNull();
        expect(screen.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.endsWith('.action.review'))).toHaveLength(0);
        expect(screen.getTextContent()).toContain('settingsPlugins.pendingChangeApplying');
        await screen.update(<PendingPluginChangesSection active target={{ serverId: 'foreign-home', machineId: 'machine-a' }} pendingChanges={[]} />);
        expect(screen.findByTestId('settings.plugins.management.pendingChanges')).toBeNull();
    });
});
