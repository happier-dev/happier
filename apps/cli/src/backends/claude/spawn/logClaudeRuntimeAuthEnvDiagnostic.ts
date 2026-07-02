import { logger } from '@/ui/logger';
import {
    readConnectedServiceChildSelectionsFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { resolveClaudeRuntimeAuthEnvDiagnostic } from '@happier-dev/plugins-claude/agent/auth/services/runtime';

function readRecord(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function resolveConnectedServiceSelectionDiagnostic(
    selection: unknown,
): Record<string, unknown> | null {
    const record = readRecord(selection);
    if (!record) return null;
    if (record.kind === 'profile') {
        return {
            kind: record.kind,
            serviceId: record.serviceId,
            profileId: record.profileId,
        };
    }
    if (record.kind !== 'group') return null;
    return {
        kind: record.kind,
        serviceId: record.serviceId,
        groupId: record.groupId,
        activeProfileId: record.activeProfileId,
        fallbackProfileId: record.fallbackProfileId,
        generation: record.generation,
    };
}

export function logClaudeRuntimeAuthEnvDiagnostic(params: Readonly<{
    logPrefix: string;
    sessionId?: string | null;
    startFrom?: string | null;
    runnerEnv: Pick<NodeJS.ProcessEnv, string>;
    childEnv: Pick<NodeJS.ProcessEnv, string>;
}>): void {
    const selections = readConnectedServiceChildSelectionsFromEnv(params.runnerEnv);
    const selection = selections?.get('claude-subscription') ?? selections?.get('anthropic') ?? null;

    logger.debug(`[${params.logPrefix}] Claude runtime auth diagnostic`, {
        sessionId: params.sessionId ?? null,
        startFrom: params.startFrom ?? null,
        connectedServiceSelection: resolveConnectedServiceSelectionDiagnostic(selection),
        runnerEnv: resolveClaudeRuntimeAuthEnvDiagnostic(params.runnerEnv),
        childEnv: resolveClaudeRuntimeAuthEnvDiagnostic(params.childEnv),
    });
}
