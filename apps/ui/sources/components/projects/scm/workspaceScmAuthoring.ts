import { SessionAuthoringOpenResultV1Schema, type PluginUiNewSessionSeedV1, type SessionAuthoringOpenResultV1 } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryResult } from '@happier-dev/protocol/scm/diffSummaryResult';
import { buildWalkthroughReading, type WalkthroughStop } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { findWorkspaceRefByScope, resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { normalizeWorkspaceRootPath, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { t } from '@/text';

/** Captured evidence becomes visible editable text, never execution or a parallel draft. */
export function buildWorkspaceScmAuthoringSeed(input: Readonly<{
    workspace: WorkspaceAddressV2;
    accountId: string;
    comparison: ScmComparison;
    result: ScmDiffSummaryResult | null;
    stopId?: string;
    question?: string;
}>): PluginUiNewSessionSeedV1 | null {
    const { workspace, comparison, result } = input;
    if (normalizeWorkspaceRootPath(workspace.rootPath) !== normalizeWorkspaceRootPath(comparison.repository.rootPath)
        || (result && result.output.comparison?.id !== comparison.id)) return null;
    const stop = input.stopId ? result && buildWalkthroughReading({
        comparison, walkthrough: result.output.outputs?.walkthrough ?? null,
        analysis: result.output.analysis ?? null, reviewed: null, provenance: result.walkthroughProvenance,
    }).stops.find(item => item.id === input.stopId) : null;
    if (input.stopId && !stop) return null;
    const evidence = stop ? stop.files.map(file => ({ path: file.path, previousPath: file.previousPath,
        ...(file.unavailableReason ? { unavailableReason: file.unavailableReason } : { unifiedDiff: file.unifiedDiff }) }))
        : comparison.inventory.files.map(file => ({ path: file.path, previousPath: file.previousPath,
            ...(file.evidence.state === 'available' ? { unifiedDiff: file.evidence.unifiedDiff }
                : { unavailableReason: file.evidence.reason }) }));
    const context = {
        workspace, comparisonId: comparison.id, source: comparison.source, endpoints: comparison.endpoints,
        inventory: { state: comparison.inventory.state, reasons: comparison.inventory.reasons },
        ...(result ? { savedResult: { resultId: result.resultId, revision: result.revision } } : {}),
        ...(stop ? { stop: { id: stop.id, title: stop.title, explanationMarkdown: stop.explanationMarkdown,
            changeRefs: stop.changeRefs, reviewExplanations: stop.reviewExplanations } } : {}),
        evidence,
    };
    return {
        prompt: `${t(stop ? 'projects.review.askPrompt' : 'projects.review.explainPrompt')}\n\n${t('projects.review.capturedContext')}\n${JSON.stringify(context, null, 2)}${stop ? `\n\n${input.question ?? t('projects.review.question')}` : ''}`,
        placement: { kind: 'exactTarget', serverId: workspace.serverId, machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace), directory: workspace.rootPath },
        checkoutIntent: 'reuseWorkspace',
        origin: { kind: 'project', accountId: input.accountId, workspace, page: 'changes', comparisonId: comparison.id },
    };
}

export type WorkspaceScmAuthoringOutcome = SessionAuthoringOpenResultV1 | ActionApprovalRequestCreatedResult;

export async function openWorkspaceScmAuthoringDraft(input: Readonly<{
    scope: WorkspaceScopeBase;
    comparison: ScmComparison;
    result: ScmDiffSummaryResult | null;
    stop?: WalkthroughStop;
    question?: string;
    /** Exact displayed comparison/revision + mounted host lifetime, supplied by the review owner. */
    isCurrent: () => boolean;
    signal?: AbortSignal;
}>): Promise<WorkspaceScmAuthoringOutcome> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !areServerProfileIdentifiersEquivalent(input.scope.serverId, lifetime.scope.serverId)
        || !input.isCurrent()) return { kind: 'stale', reason: 'host_retired' };
    const checkout = findWorkspaceRefByScope(readProjectWorkspaceRefs(storage.getState()), input.scope);
    if (!checkout) return { kind: 'unavailable', reason: 'origin_unavailable' };
    const workspace = workspaceAddressFromRefV2(checkout);
    const seed = buildWorkspaceScmAuthoringSeed({ workspace, accountId: lifetime.scope.accountId,
        comparison: input.comparison, result: input.result, ...(input.stop ? { stopId: input.stop.id } : {}),
        ...(input.question ? { question: input.question } : {}) });
    if (!seed) return { kind: 'unavailable', reason: 'origin_unavailable' };
    const current = () => !input.signal?.aborted && lifetime.isCurrent() && input.isCurrent()
        && resolveWorkspaceRefByAddress(readProjectWorkspaceRefs(storage.getState()), workspace).kind === 'resolved';
    try {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        if (!current()) return { kind: 'stale', reason: 'host_retired' };
        // Run-now present-user entry: only `execute` offers the in-place default confirmation.
        const response = await createFrontDoorActionExecute(createDefaultActionExecutor())('session.authoring.open', { seed }, {
            surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
            expectedAccountId: lifetime.scope.accountId, ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!current()) return { kind: 'stale', reason: 'host_retired' };
        if (!response.ok) return { kind: 'unavailable', reason: 'navigation_unavailable' };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response.result);
        if (approval.success) return approval.data;
        const outcome = SessionAuthoringOpenResultV1Schema.safeParse(response.result);
        return outcome.success ? outcome.data : { kind: 'unavailable', reason: 'navigation_unavailable' };
    } catch {
        return current() ? { kind: 'unavailable', reason: 'navigation_unavailable' } : { kind: 'stale', reason: 'host_retired' };
    }
}
