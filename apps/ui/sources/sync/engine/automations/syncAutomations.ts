import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Automation, AutomationRun } from '@/sync/domains/automations/automationTypes';
import { listAutomations } from '@/sync/api/automations/apiAutomations';
import { listAutomationRuns } from '@/sync/api/automations/apiAutomationRuns';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export async function fetchAndApplyAutomations(params: {
    credentials: AuthCredentials | null | undefined;
    applyAutomations: (automations: Automation[]) => void;
    loadedAutomationRunIds?: readonly string[];
    setAutomationRuns?: (automationId: string, runs: AutomationRun[]) => void;
    runsLimit?: number;
    shouldContinue?: () => boolean;
}): Promise<void> {
    if (!params.credentials) {
        return;
    }
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

    const { serverId } = getActiveServerSnapshot();
    const automationsEnabled = await isRuntimeFeatureEnabled({
        featureId: 'automations',
        serverId,
        timeoutMs: 400,
    });
    if (!shouldContinue()) return;
    if (!automationsEnabled) {
        return;
    }

    const rows = await listAutomations(params.credentials);
    if (!shouldContinue()) return;
    params.applyAutomations(rows);

    if (!params.setAutomationRuns) {
        return;
    }

    const loadedAutomationRunIds = Array.from(new Set(params.loadedAutomationRunIds ?? []));
    if (loadedAutomationRunIds.length === 0) {
        return;
    }

    const rowIds = new Set(rows.map((row) => row.id));
    const idsToRefresh = loadedAutomationRunIds.filter((automationId) => rowIds.has(automationId));
    if (idsToRefresh.length === 0) {
        return;
    }

    const limit = params.runsLimit ?? 20;
    await Promise.all(idsToRefresh.map(async (automationId) => {
        const result = await listAutomationRuns({
            credentials: params.credentials!,
            automationId,
            limit,
        });
        if (!shouldContinue()) return;
        params.setAutomationRuns?.(automationId, result.runs);
    }));
}

export async function fetchAndApplyAutomationRuns(params: {
    credentials: AuthCredentials | null | undefined;
    automationId: string;
    limit?: number;
    setAutomationRuns: (automationId: string, runs: AutomationRun[]) => void;
    shouldContinue?: () => boolean;
}): Promise<{ nextCursor: string | null }> {
    if (!params.credentials) {
        return { nextCursor: null };
    }
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return { nextCursor: null };

    const { serverId } = getActiveServerSnapshot();
    const automationsEnabled = await isRuntimeFeatureEnabled({
        featureId: 'automations',
        serverId,
        timeoutMs: 400,
    });
    if (!shouldContinue()) return { nextCursor: null };
    if (!automationsEnabled) {
        return { nextCursor: null };
    }

    const result = await listAutomationRuns({
        credentials: params.credentials,
        automationId: params.automationId,
        limit: params.limit,
    });
    if (!shouldContinue()) return { nextCursor: null };
    params.setAutomationRuns(params.automationId, result.runs);
    return { nextCursor: result.nextCursor };
}
