import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from '@/sync/domains/automations/automationTypes';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import {
    listAutomationDefinitions,
    type AutomationRequestContext,
} from '@/sync/api/automations/apiAutomations';
import { listAutomationDefinitionRuns } from '@/sync/api/automations/apiAutomationRuns';
import { resolveRuntimeFeatureDecisionOrThrow } from '@/sync/domains/features/featureDecisionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import type { AutomationDefinitionListResponse } from '@happier-dev/protocol/automations/automationApiV3';

/** Only a proven source-status change can omit the presented Run-window refresh. */
export type AutomationRefreshOptions = Readonly<{ summariesOnly: true }>;

export async function fetchAndApplyAutomations(params: {
    credentials: AuthCredentials | null | undefined;
    applyAutomations: (automations: AutomationDefinition[], nextCursor: string | null) => number | null;
    appendAutomations?: (
        expectedCursor: string,
        expectedTraversalToken: number,
        automations: AutomationDefinition[],
        nextCursor: string | null,
    ) => boolean;
    cursor?: string;
    traversalToken?: number;
    getDemandedAutomationRunIds?: () => readonly string[];
    /**
     * The list refresh restates the newest Run page for presented histories.
     * It is not the reader asking to start over, so it writes through
     * the projection owner that cannot rewind an in-progress traversal.
     */
    refreshAutomationRunsWindow?: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    runsLimit?: number;
    /** The incumbent Sync binding supplies both HTTP and feature identity. */
    requestContext?: AutomationRequestContext;
    shouldContinue?: () => boolean;
    /** One startup continuation may consume this feature-admitted response, never a default store snapshot. */
    onDefinitionsRead?: (page: AutomationDefinitionListResponse) => void;
}): Promise<{ nextCursor: string | null; traversalToken: number | null }> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!params.credentials) {
        return { nextCursor: null, traversalToken: null };
    }
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };

    const serverId = params.requestContext?.serverId ?? getActiveServerSnapshot().serverId;
    const automationsDecision = await resolveRuntimeFeatureDecisionOrThrow({
        featureId: 'workflows',
        serverId,
    });
    if (automationsDecision.state !== 'enabled') {
        return { nextCursor: null, traversalToken: null };
    }
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };

    const result = await listAutomationDefinitions(params.credentials, {
        ...(params.cursor ? { cursor: params.cursor } : {}),
    }, params.requestContext);
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };
    params.onDefinitionsRead?.(result);
    const automations = result.automations.map(createAutomationDefinitionSummary);
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };
    let traversalToken: number | null;
    if (params.cursor) {
        if (params.traversalToken === undefined || !params.appendAutomations?.(
            params.cursor,
            params.traversalToken,
            automations,
            result.nextCursor,
        )) {
            return { nextCursor: null, traversalToken: null };
        }
        traversalToken = result.nextCursor === null ? null : params.traversalToken;
    } else {
        traversalToken = params.applyAutomations(automations, result.nextCursor);
    }

    if (params.cursor || !params.refreshAutomationRunsWindow) {
        return { nextCursor: result.nextCursor, traversalToken };
    }

    const demandedAutomationRunIds = Array.from(new Set(params.getDemandedAutomationRunIds?.() ?? []));
    if (demandedAutomationRunIds.length === 0) {
        return { nextCursor: result.nextCursor, traversalToken };
    }

    const rowIds = new Set(automations.map((automation) => automation.id));
    const idsToRefresh = demandedAutomationRunIds.filter((automationId) => rowIds.has(automationId));
    if (idsToRefresh.length === 0) {
        return { nextCursor: result.nextCursor, traversalToken };
    }

    const limit = params.runsLimit ?? 20;
    // Current presentation owns demand; cache retention never expands it.
    // Reuse the existing Automation request-concurrency owner for visible lists.
    await runTasksWithLimit(
        idsToRefresh.map((automationId) => async () => {
            if (!shouldContinue() || !params.getDemandedAutomationRunIds?.().includes(automationId)) return;
            const result = await listAutomationDefinitionRuns({
                credentials: params.credentials!,
                automationId,
                limit,
                ...(params.requestContext ? { requestContext: params.requestContext } : {}),
            });
            if (!shouldContinue()) return;
            params.refreshAutomationRunsWindow?.(automationId, result.runs, result.nextCursor);
        }),
        loadSyncTuning().automationDefinitionDetailHydrationConcurrencyLimit,
    );
    return { nextCursor: result.nextCursor, traversalToken };
}

export async function fetchAndApplyAutomationRuns(params: {
    credentials: AuthCredentials | null | undefined;
    automationId: string;
    limit?: number;
    cursor?: string;
    traversalToken?: number;
    setAutomationRuns: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => number | null;
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        expectedTraversalToken: number,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => boolean;
    /** The incumbent Sync binding supplies both HTTP and feature identity. */
    requestContext?: AutomationRequestContext;
    shouldContinue?: () => boolean;
}): Promise<{ nextCursor: string | null; traversalToken: number | null }> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!params.credentials) {
        return { nextCursor: null, traversalToken: null };
    }
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };

    const serverId = params.requestContext?.serverId ?? getActiveServerSnapshot().serverId;
    const automationsDecision = await resolveRuntimeFeatureDecisionOrThrow({
        featureId: 'workflows',
        serverId,
    });
    if (automationsDecision.state !== 'enabled') {
        return { nextCursor: null, traversalToken: null };
    }
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };

    const result = await listAutomationDefinitionRuns({
        credentials: params.credentials,
        automationId: params.automationId,
        limit: params.limit,
        cursor: params.cursor,
        ...(params.requestContext ? { requestContext: params.requestContext } : {}),
    });
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };
    let traversalToken: number | null;
    if (params.cursor) {
        if (params.traversalToken === undefined || !params.appendAutomationRuns(
            params.automationId,
            params.cursor,
            params.traversalToken,
            result.runs,
            result.nextCursor,
        )) {
            return { nextCursor: null, traversalToken: null };
        }
        traversalToken = result.nextCursor === null ? null : params.traversalToken;
    } else {
        traversalToken = params.setAutomationRuns(params.automationId, result.runs, result.nextCursor);
    }
    return { nextCursor: result.nextCursor, traversalToken };
}
