import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Automation, AutomationRun } from '@/sync/domains/automations/automationTypes';
import { listAutomations } from '@/sync/api/automations/apiAutomations';
import { listAutomationRuns } from '@/sync/api/automations/apiAutomationRuns';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export async function fetchAndApplyAutomations(params: {
    credentials: AuthCredentials | null | undefined;
    applyAutomations: (automations: Automation[]) => void;
}): Promise<void> {
    if (!params.credentials) {
        return;
    }

    const { serverId } = getActiveServerSnapshot();
    const automationsEnabled = await isRuntimeFeatureEnabled({
        featureId: 'automations',
        serverId,
        timeoutMs: 400,
    });
    if (!automationsEnabled) {
        return;
    }

    const rows = await listAutomations(params.credentials);
    params.applyAutomations(rows);
}

export async function fetchAndApplyAutomationRuns(params: {
    credentials: AuthCredentials | null | undefined;
    automationId: string;
    limit?: number;
    setAutomationRuns: (automationId: string, runs: AutomationRun[]) => void;
}): Promise<{ nextCursor: string | null }> {
    if (!params.credentials) {
        return { nextCursor: null };
    }

    const { serverId } = getActiveServerSnapshot();
    const automationsEnabled = await isRuntimeFeatureEnabled({
        featureId: 'automations',
        serverId,
        timeoutMs: 400,
    });
    if (!automationsEnabled) {
        return { nextCursor: null };
    }

    const result = await listAutomationRuns({
        credentials: params.credentials,
        automationId: params.automationId,
        limit: params.limit,
    });
    params.setAutomationRuns(params.automationId, result.runs);
    return { nextCursor: result.nextCursor };
}
