import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ScmComparisonSchema, ScmDiffSummaryResultSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ScmComparison } from '@happier-dev/protocol/scm';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

const boundary = vi.hoisted(() => ({ calls: [] as Array<{ method: string; payload: unknown; accountId?: string | null }>,
    response: null as unknown, savedResponse: null as unknown,
    list: null as import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState | null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The platform recycler has no viewport in the renderer; the testkit renders its rows while all Files domain logic remains real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() });
    boundary.list = mock.state;
    return mock.module;
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'captured-account' })).toString('base64')}.signature`, secret: 'fixture-secret' }),
    } });
});
// Authenticated Machine RPC is the external boundary; source mapping, capture decoding and scope lifetime stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; payload: unknown; accountId?: string | null }) => {
        boundary.calls.push(request);
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return boundary.response;
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ && boundary.savedResponse) return boundary.savedResponse;
        throw new Error(`Unexpected machine boundary: ${request.method}`);
    };
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
const { renderHook, renderScreen, standardCleanup, createSessionFixture, createMachineFixture } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storage');
const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { useSessionCapturedScmComparison } = await import('./useSessionCapturedScmComparison');
// Router mounts after the app entry publishes the real sync runtime; reproduce that bootstrap.
await import('@/sync/syncEngine');
const { SessionScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { readSessionScmReviewTarget } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { loadSavedScmDiffSummaryResult, retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
const initialStorage = getStorage().getState();
const scopes: Array<{ serverId: string; accountId: string }> = [];
function PaneProbe({ scopeId }: { scopeId: string }) {
    return React.createElement('PaneProbe', { state: useAppPaneScope(scopeId).scopeState });
}
afterEach(() => { standardCleanup(); for (const scope of scopes.splice(0)) retireScmDiffSummaryScope(scope);
    getStorage().setState(initialStorage, true); boundary.calls = []; boundary.response = null; boundary.savedResponse = null; });

async function mount(comparison: SessionScmReviewComparison) {
    const sessionId = `capture-${comparison.kind}`;
    const home = await upsertServerProfile({ name: sessionId, serverUrl: `https://${sessionId}.example.test` });
    await setActiveServerId(home.id, { scope: 'device' });
    const machine = createMachineFixture({ id: `machine:${sessionId}`, activeAt: Date.now() });
    const session = createSessionFixture({ id: sessionId, serverId: home.id, active: true,
        metadata: { path: '/repo/exact', host: 'tester.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } });
    return renderHook<ReturnType<typeof useSessionCapturedScmComparison>, ScmComparison | null>(
        (knownComparison) => useSessionCapturedScmComparison({ sessionId, serverId: home.id, comparison, knownComparison }), { initialProps: null });
}

describe('Files reads the canonical captured comparison through authenticated RPC', () => {
    it.each([
        { state: 'complete', reasons: [], before: 'initial-tree', after: 'initial-tree' },
        { state: 'unavailable', reasons: ['Session initial checkpoint is unavailable'], before: undefined, after: undefined },
    ] as const)('shows the Session checkpoint net as $state, preserving an empty reversion or missing baseline', async ({ state, reasons, before, after }) => {
        const source = { kind: 'session' as const };
        const comparison = ScmComparisonSchema.parse({ id: 's'.repeat(64), source: { ...source, sessionId: 'capture-session' },
            repository: { rootPath: '/repo/exact' }, endpoints: { before, after },
            inventory: { state, files: [], reasons } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const serverId = getStorage().getState().sessions['capture-session']!.serverId;
        const screen = await renderScreen(<AppPaneProvider><PaneProbe scopeId="session:capture-session" /><SessionScmReviewDetailsView sessionId="capture-session"
            serverId={serverId} scopeId="session:capture-session" target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        expect(Boolean(screen.findByTestId('captured-inventory-incomplete'))).toBe(state === 'unavailable');
        expect(boundary.calls.map((call) => call.method)).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE]);
        const capturedView = screen.findByType((await import('./CapturedComparisonFilesView')).CapturedComparisonFilesView);
        expect(capturedView.props.comparison).toEqual(comparison);
        expect(capturedView.props.comparison.inventory.files).toEqual([]);
        const switchView = screen.findByType((await import('./ScmComparisonBar')).ScmComparisonViewSwitch);
        await act(async () => screen.pressByTestId('scm-comparison-view:walkthrough'));
        expect(screen.findByType('PaneProbe' as never).props.state.details.tabs[0]?.resource)
            .toMatchObject({ comparison: { kind: 'session', comparisonId: comparison.id }, view: 'walkthrough' });
        expect(switchView.props.view).toBe('files');
    });
    it.each([
        { kind: 'branch', head: 'HEAD', base: 'main' },
        { kind: 'commit', commit: 'HEAD' },
        { kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repo', number: 42 } },
    ] as const)('pins captured $kind evidence when Files opens its first Walkthrough', async (source) => {
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source,
            repository: { rootPath: '/repo/exact' }, endpoints: { before: 'captured-before', after: 'captured-after' },
            inventory: { state: 'complete', files: [], reasons: [] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const sessionId = `capture-${source.kind}`;
        const scopeId = `session:${sessionId}`;
        const serverId = getStorage().getState().sessions[sessionId]!.serverId;
        const screen = await renderScreen(<AppPaneProvider><PaneProbe scopeId={scopeId} /><SessionScmReviewDetailsView
            sessionId={sessionId} serverId={serverId} scopeId={scopeId} target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        expect(screen.findByType((await import('./CapturedComparisonFilesView')).CapturedComparisonFilesView).props.comparison.endpoints)
            .toEqual(comparison.endpoints);
        await act(async () => screen.pressByTestId('scm-comparison-view:walkthrough'));
        expect(screen.findByType('PaneProbe' as never).props.state.details.tabs[0]?.resource)
            .toMatchObject({ comparison: { ...source, comparisonId: comparison.id }, view: 'walkthrough' });
        expect(boundary.calls.map((call) => call.method)).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE]);
    });
    it('loads PR inventory before any narration or working-copy snapshot exists', async () => {
        const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'owner/repo', number: 42 } };
        const comparison = ScmComparisonSchema.parse({ id: 'pinned-pr', source, repository: { rootPath: '/repo/exact' },
            endpoints: { before: 'base-oid', after: 'head-oid' }, freshness: 'unknown', inventory: { state: 'incomplete', files: [], reasons: ['page_failed'] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await vi.waitFor(() => expect(hook.getCurrent().comparison).toEqual(comparison));
        expect(boundary.calls).toEqual([expect.objectContaining({ method: RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE,
            payload: { sessionId: 'capture-pullRequest', cwd: '/repo/exact', source } })]);
    });
    it('reads a pinned identity and preserves an unavailable response without recapturing source', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        boundary.response = { success: false, error: 'saved_evidence_missing', errorCode: 'SCM_DIFF_SUMMARY_SOURCE_UNAVAILABLE' };
        const comparisonId = 'c'.repeat(64);
        const hook = await mount({ ...source, comparisonId });
        await vi.waitFor(() => expect(hook.getCurrent().error).toBe('saved_evidence_missing'));
        expect(hook.getCurrent().comparison).toBeNull();
        expect(boundary.calls).toEqual([expect.objectContaining({ payload: { sessionId: 'capture-commit', cwd: '/repo/exact', source, comparisonId } })]);
    });
    it('clears a failed read when exact saved evidence becomes available without recapturing', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        const id = 'c'.repeat(64);
        boundary.response = { success: false, error: 'saved_evidence_missing', errorCode: 'SCM_DIFF_SUMMARY_SOURCE_UNAVAILABLE' };
        const hook = await mount({ ...source, comparisonId: id });
        await vi.waitFor(() => expect(hook.getCurrent().error).toBe('saved_evidence_missing'));
        const saved = ScmComparisonSchema.parse({ id, source, repository: { rootPath: '/old/exact' }, endpoints: { before: 'before', after: 'after' },
            inventory: { state: 'complete', files: [], reasons: [] } });
        await hook.rerender(saved);
        expect(hook.getCurrent()).toMatchObject({ comparison: saved, loading: false, error: null });
        expect(boundary.calls).toHaveLength(1);
    });
    it('renders captured Files without a checkout snapshot or checkout RPCs', async () => {
        const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'owner/repo', number: 42 } };
        const comparison = ScmComparisonSchema.parse({ id: 'captured-ui', source, repository: { rootPath: '/repo/exact' },
            endpoints: { before: 'base-oid', after: 'head-oid' }, freshness: 'unknown', inventory: { state: 'incomplete', reasons: ['page_failed'], files: [
                { path: 'new.ts', previousPath: 'old.ts', changeKind: 'renamed', binary: false, generated: false, lockfile: false,
                    evidence: { state: 'available', unifiedDiff: 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n' }, occurrences: [] },
                { path: 'missing.png', changeKind: 'added', binary: null, generated: false, lockfile: false,
                    evidence: { state: 'unavailable', reason: 'patch_unavailable' }, occurrences: [] },
                { path: 'captured-image.png', changeKind: 'added', binary: true, generated: false, lockfile: false,
                    evidence: { state: 'available', unifiedDiff: '' }, occurrences: [] },
            ] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const serverId = getStorage().getState().sessions['capture-pullRequest']!.serverId;
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId="capture-pullRequest"
            serverId={serverId} scopeId="session:capture-pullRequest" target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        expect(screen.findByTestId('captured-inventory-incomplete')).toBeTruthy();
        expect(screen.findByTestId('captured-comparison-freshness')).toBeTruthy();
        expect(screen.findByTestId('captured-comparison-endpoints')).toBeNull();
        expect(screen.findByTestId('captured-file-unavailable-missing.png')).toBeTruthy();
        expect(screen.findByTestId('scm-review-diff-area-menu')).toBeNull();
        expect(boundary.calls.map((call) => call.method)).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE]);
    });
    it('opens direct Walkthrough with its saved exact evidence and enables review without recapturing', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        boundary.response = { success: false, error: 'must_not_recapture' };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const serverId = getStorage().getState().sessions['capture-commit']!.serverId!;
        const scope = { serverId, accountId: 'captured-account' };
        scopes.push(scope);
        const id = 'c'.repeat(64);
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'saved-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'saved-result', revision: 1, sourceKey: id, metadata: { sourceKey: id, source },
                comparison: { id, source, repository: { rootPath: '/old/exact' }, endpoints: { before: 'old-before', after: 'old-after' },
                    inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'pending' } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        loadSavedScmDiffSummaryResult({ sessionId: 'capture-commit', scope, result });
        boundary.savedResponse = { success: true, result };
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId="capture-commit"
            serverId={serverId} scopeId="session:capture-commit" target={{ comparison: source, view: 'walkthrough' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-start-review')?.props.disabled).toBe(false));
        expect(boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toEqual([]);
        expect(boundary.calls.find((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)?.payload)
            .toEqual({ cwd: '/old/exact', resultId: 'saved-result' });
    });
    it('keeps captured Files readable and disables review with a reason when its Machine goes offline', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        const comparison = ScmComparisonSchema.parse({ id: 'offline-comparison', source, repository: { rootPath: '/repo/exact' }, endpoints: {},
            inventory: { state: 'complete', files: [], reasons: [] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        const sessionId = 'capture-commit';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId={sessionId}
            serverId={serverId} scopeId={`session:${sessionId}`} target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-start-review')?.props.disabled).toBe(false));
        const machine = getStorage().getState().machineListByServerId[serverId]![0]!;
        await act(async () => getStorage().setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: 1 } },
            machineListByServerId: { [serverId]: [{ ...machine, active: false, activeAt: 1 }] } }));
        const review = screen.findByTestId('scm-comparison-start-review');
        expect(review?.props.disabled).toBe(true);
        expect(review?.props.accessibilityHint).toEqual(expect.any(String));
        expect(screen.findHostByTestId('captured-comparison-files')).toBeTruthy();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        // Calling the owner handler directly must be safe even when a stale trigger fires.
        await act(async () => review!.props.onPress());
        expect(Modal.show).not.toHaveBeenCalled();
        const capturedView = screen.findByType((await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView')).SessionCapturedScmReviewDetailsView);
        await act(async () => capturedView.findAll((node) => typeof node.props.onLayout === 'function')[0]!
            .props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
        const menu = screen.findAllByType((await import('@/components/ui/forms/dropdown/DropdownMenu')).DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-phone-actions')!;
        expect(menu.props.items.find((item: { id: string }) => item.id === 'start-review'))
            .toMatchObject({ disabled: true, subtitle: expect.any(String) });
        await act(async () => menu.props.onSelect('start-review'));
        expect(Modal.show).not.toHaveBeenCalled();
        await act(async () => getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } }));
        expect(screen.findAllByType((await import('@/components/ui/forms/dropdown/DropdownMenu')).DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-phone-actions')!.props.items
            .find((item: { id: string }) => item.id === 'start-review').disabled).toBe(false);
    });
    it('recomposes phone Files into the standard header while keeping view and scope navigation reachable', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        const comparison = ScmComparisonSchema.parse({ id: 'phone-comparison', source, repository: { rootPath: '/repo/exact' }, endpoints: {},
            inventory: { state: 'complete', files: [], reasons: [] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        const sessionId = 'capture-commit';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const scopeId = `session:${sessionId}`;
        const screen = await renderScreen(<AppPaneProvider><PaneProbe scopeId={scopeId} /><SessionScmReviewDetailsView sessionId={sessionId}
            serverId={serverId} scopeId={scopeId} target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        const { SessionCapturedScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView');
        const root = screen.findByType(SessionCapturedScmReviewDetailsView).findAll((node) => typeof node.props.onLayout === 'function')[0]!;
        await act(async () => root.props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
        expect(screen.findByTestId('scm-comparison-bar')).toBeNull();
        expect(screen.findByTestId('scm-comparison-phone-back')).toBeTruthy();
        const menu = screen.findAllByType((await import('@/components/ui/forms/dropdown/DropdownMenu')).DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-phone-actions')!;
        await act(async () => menu.props.onSelect('view:walkthrough'));
        expect(screen.findByType('PaneProbe' as never).props.state.details.tabs[0]?.resource)
            .toMatchObject({ comparison: { ...source, comparisonId: comparison.id }, view: 'walkthrough' });
    });
    it('shows saved reading coverage in phone Files and jumps between captured files without opening the checkout', async () => {
        const { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH, SPECIMEN_ANALYSIS_COMPLETE } = await import('@/components/dev/changes/walkthroughSpecimenFixture');
        const source = { kind: 'commit' as const, commit: 'saved-ref' };
        const comparison = ScmComparisonSchema.parse({ ...SPECIMEN_COMPARISON, source });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        const serverId = getStorage().getState().sessions['capture-commit']!.serverId!;
        const scope = { serverId, accountId: 'captured-account' };
        scopes.push(scope);
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'phone-reading', revision: 1, canUndo: false,
            output: { success: true, resultId: 'phone-reading', revision: 1, sourceKey: comparison.id,
                metadata: { sourceKey: comparison.id, source }, comparison, requestedOutputs: ['walkthrough'],
                producer: { kind: 'generation', modelId: 'fixture-model' },
                outputs: { walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH } }, analysis: SPECIMEN_ANALYSIS_COMPLETE } });
        loadSavedScmDiffSummaryResult({ sessionId: 'capture-commit', scope, result });
        // The real Details surface feeds its current pane resource back into the view after navigation.
        function SavedFilesPane() {
            const pane = useAppPaneScope('session:capture-commit');
            const tab = pane.scopeState?.details.tabs.find((candidate) => candidate.kind === 'scmReview');
            const target = tab ? readSessionScmReviewTarget(tab.resource)
                : { comparison: { ...source, comparisonId: comparison.id }, view: 'files' as const };
            return <SessionScmReviewDetailsView sessionId="capture-commit" serverId={serverId}
                scopeId="session:capture-commit" target={target} />;
        }
        const screen = await renderScreen(<AppPaneProvider><SavedFilesPane /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('captured-comparison-files')).toBeTruthy());
        const owner = screen.findByType((await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView')).SessionCapturedScmReviewDetailsView);
        await act(async () => owner.findAll((node) => typeof node.props.onLayout === 'function')[0]!
            .props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
        // Captured Files can render from cache before the saved reading's
        // credential-backed Account binding has finished resolving.
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(SPECIMEN_WALKTHROUGH.title));
        expect(screen.findByTestId('walkthrough-analysis-fact')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-explain')?.props.accessibilityState?.checked).toBe(false);
        expect(screen.findByTestId('scm-comparison-layout:list')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-layout:tree')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-file-control')).toBeTruthy();
        await act(async () => screen.pressByTestId('scm-comparison-explain'));
        expect(screen.findByTestId('scm-comparison-explain')?.props.accessibilityState?.checked).toBe(true);
        await act(async () => screen.pressByTestId('scm-comparison-explain'));
        expect(screen.findByTestId('scm-comparison-explain')?.props.accessibilityState?.checked).toBe(false);
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const control = screen.findAllByType(DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-file-picker')!;
        boundary.list!.refHandle.scrollToIndex.mockClear();
        const secondPath = comparison.inventory.files[1]!.path;
        await act(async () => control.props.onSelect(secondPath));
        await vi.waitFor(() => expect(boundary.list!.refHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1, animated: false })));
        // The real viewport boundary reports scrolling to a different file; the control follows it.
        await act(async () => screen.findHostByTestId('scm-review-list')!.props.onViewableItemsChanged({ viewableItems: [{ index: 2, isViewable: true }], changed: [] }));
        await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-file-picker')!.props.selectedId).toBe(comparison.inventory.files[2]!.path));
    });
});
import * as React from 'react';
