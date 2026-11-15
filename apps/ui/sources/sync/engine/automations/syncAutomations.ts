import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from '@/sync/domains/automations/automationTypes';
import { createAutomationDefinitionSummary, createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import {
    getAutomationDefinition,
    listAutomationDefinitions,
    listAutomationDefinitionDetails,
    type AutomationRequestContext,
} from '@/sync/api/automations/apiAutomations';
import { listAutomationDefinitionRuns } from '@/sync/api/automations/apiAutomationRuns';
import { resolveRuntimeFeatureDecisionOrThrow } from '@/sync/domains/features/featureDecisionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import type { AutomationDefinitionListResponse } from '@happier-dev/protocol/automations/automationApiV3';
import {
    resolveValidatedAutomationAccountEncryptionV1,
    sameAutomationAccountContentIdentityV1,
    type AvailableAutomationAccountEncryptionV1,
} from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import {
    hasPrivateAutomationDefinitionDisplayCarrierV1,
    readAutomationDefinitionDisplayV1,
} from '@happier-dev/protocol/automations/automationDefinitionDisplayReaderV1';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { deriveAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

async function openAutomationListDisplays<T extends AutomationDefinitionListResponse['automations'][number]>(params: Readonly<{
    credentials: AuthCredentials;
    requestContext?: AutomationRequestContext;
    serverId: string | null | undefined;
    automations: T[];
    shouldContinue: () => boolean;
}>): Promise<T[]> {
    if (!params.automations.some(hasPrivateAutomationDefinitionDisplayCarrierV1)) return params.automations;
    const resolveEncryption = async (): Promise<AvailableAutomationAccountEncryptionV1> => {
        const resolved = await resolveValidatedAutomationAccountEncryptionV1({
            signal: new AbortController().signal,
            resolveAccountEncryptionCurrentness: async signal => await fetchAccountEncryptionCurrentness(params.credentials,
                params.requestContext ? {
                    request: (path, init) => params.requestContext!.request(path, init, { includeAuth: false }),
                    signal,
                } : { signal }),
            resolveAccountEncryptionMaterial: async () => deriveAccountScopedCryptoMaterialSnapshot(
                params.credentials,
                params.serverId,
            ),
        });
        if (resolved.kind !== 'available') {
            throw Object.assign(new Error('automation_stored_content_unavailable'), { code: 'automation_stored_content_unavailable' });
        }
        return resolved;
    };
    const opened = await resolveEncryption();
    if (!params.shouldContinue()) return params.automations;
    const automations = params.automations.map((automation) => {
        if (!hasPrivateAutomationDefinitionDisplayCarrierV1(automation)) return automation;
        const display = readAutomationDefinitionDisplayV1({ definition: automation, encryption: opened });
        if (display.kind !== 'available') {
            throw Object.assign(new Error('automation_stored_content_unavailable'), { code: 'automation_stored_content_unavailable' });
        }
        return { ...automation, name: display.display.name, description: display.display.description };
    });
    if (!params.shouldContinue()) return automations;
    const current = await resolveEncryption();
    if (!sameAutomationAccountContentIdentityV1(opened.witness, current.witness)) {
        throw Object.assign(new Error('automation_stored_content_unavailable'), { code: 'automation_stored_content_unavailable' });
    }
    return automations;
}

/** Exact demanded definition names, opened by the same private-display owner as Automation lists. */
export async function readAutomationDefinitionDisplaysByIds(
    automationIds: readonly string[],
    options: Readonly<{ accountLifetime: ServerAccountScopeLifetime; signal?: AbortSignal }>,
): Promise<readonly Readonly<{ automationId: string; displayName: string }>[]> {
    const ids = [...new Set(automationIds)];
    const shouldContinue = () => options.accountLifetime.isCurrent() && !options.signal?.aborted;
    if (ids.length === 0 || !shouldContinue()) return [];
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(options.accountLifetime.scope.serverId, options.signal);
    try {
        if (!areServerAccountScopesEqual(context.accountLifetime.scope, options.accountLifetime.scope)) return [];
        const rows = await runTasksWithLimit(ids.map(id => async () => {
            if (!shouldContinue()) return null;
            return getAutomationDefinition(context.credentials, id, context).catch(() => null);
        }), loadSyncTuning().automationDefinitionDetailHydrationConcurrencyLimit);
        if (!shouldContinue()) return [];
        const opened = await openAutomationListDisplays({ credentials: context.credentials, requestContext: context,
            serverId: context.serverId, automations: rows.filter(row => row !== null), shouldContinue });
        return shouldContinue() ? opened.flatMap(row => row.name ? [{ automationId: row.id, displayName: row.name }] : []) : [];
    } finally { context.dispose(); }
}

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
    /** Presented source readers replace the summary acquisition with this same private page. */
    includePrivateDefinitions?: boolean;
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

    const projectPage = async <T extends AutomationDefinitionListResponse['automations'][number]>(
        page: Readonly<{ automations: T[]; nextCursor: string | null }>, project: (value: T) => AutomationDefinition,
    ) => {
        if (!shouldContinue()) return { automations: [], nextCursor: null };
        params.onDefinitionsRead?.(page);
        const opened = await openAutomationListDisplays({ credentials: params.credentials!, requestContext: params.requestContext,
            serverId, automations: page.automations, shouldContinue });
        return { automations: opened.map(project), nextCursor: page.nextCursor };
    };
    const query = { ...(params.cursor ? { cursor: params.cursor } : {}) };
    const result = params.includePrivateDefinitions
        ? await projectPage(await listAutomationDefinitionDetails(params.credentials, query, params.requestContext), createAutomationDefinitionFromDetail)
        : await projectPage(await listAutomationDefinitions(params.credentials, query, params.requestContext), createAutomationDefinitionSummary);
    if (!shouldContinue()) return { nextCursor: null, traversalToken: null };
    const automations = result.automations;
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
