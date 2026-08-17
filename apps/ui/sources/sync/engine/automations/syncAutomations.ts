import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from '@/sync/domains/automations/automationTypes';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import { listAutomationDefinitionsV3 } from '@/sync/api/automations/apiAutomations';
import { listAutomationDefinitionRunsV3 } from '@/sync/api/automations/apiAutomationRuns';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export async function fetchAndApplyAutomations(params: {
    credentials: AuthCredentials | null | undefined;
    applyAutomations: (automations: AutomationDefinition[]) => void;
    loadedAutomationRunIds?: readonly string[];
    setAutomationRuns?: (automationId: string, runs: AutomationDefinitionRun[], nextCursor: string | null) => void;
    runsLimit?: number;
    shouldContinue?: () => boolean;
}): Promise<void> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!params.credentials) {
        return;
    }
    if (!shouldContinue()) return;

    const { serverId } = getActiveServerSnapshot();
    const automationsEnabled = await isRuntimeFeatureEnabled({
        featureId: 'automations',
        serverId,
        timeoutMs: 400,
    });
    if (!automationsEnabled) {
        return;
    }
    if (!shouldContinue()) return;

    const rows = await listAutomationDefinitionsV3(params.credentials);
    if (!shouldContinue()) return;
    const automations = rows.map(createAutomationDefinitionSummary);
    if (!shouldContinue()) return;
    params.applyAutomations(automations);

    if (!params.setAutomationRuns) {
        return;
    }

    const loadedAutomationRunIds = Array.from(new Set(params.loadedAutomationRunIds ?? []));
    if (loadedAutomationRunIds.length === 0) {
        return;
    }

    const rowIds = new Set(automations.map((automation) => automation.id));
    const idsToRefresh = loadedAutomationRunIds.filter((automationId) => rowIds.has(automationId));
    if (idsToRefresh.length === 0) {
        return;
    }

    const limit = params.runsLimit ?? 20;
    await Promise.all(idsToRefresh.map(async (automationId) => {
        if (!shouldContinue()) return;
        const result = await listAutomationDefinitionRunsV3({
            credentials: params.credentials!,
            automationId,
            limit,
        });
        if (!shouldContinue()) return;
        params.setAutomationRuns?.(automationId, result.runs, result.nextCursor);
    }));
}

export async function fetchAndApplyAutomationRuns(params: {
    credentials: AuthCredentials | null | undefined;
    automationId: string;
    limit?: number;
    cursor?: string;
    setAutomationRuns: (automationId: string, runs: AutomationDefinitionRun[], nextCursor: string | null) => void;
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    shouldContinue?: () => boolean;
}): Promise<{ nextCursor: string | null }> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!params.credentials) {
        return { nextCursor: null };
    }
    if (!shouldContinue()) return { nextCursor: null };

    const { serverId } = getActiveServerSnapshot();
    const automationsEnabled = await isRuntimeFeatureEnabled({
        featureId: 'automations',
        serverId,
        timeoutMs: 400,
    });
    if (!automationsEnabled) {
        return { nextCursor: null };
    }
    if (!shouldContinue()) return { nextCursor: null };

    const result = await listAutomationDefinitionRunsV3({
        credentials: params.credentials,
        automationId: params.automationId,
        limit: params.limit,
        cursor: params.cursor,
    });
    if (!shouldContinue()) return { nextCursor: null };
    if (params.cursor) {
        params.appendAutomationRuns(params.automationId, params.cursor, result.runs, result.nextCursor);
    } else {
        params.setAutomationRuns(params.automationId, result.runs, result.nextCursor);
    }
    return { nextCursor: result.nextCursor };
}
