import { canResumeSessionWithOptions } from '@/agents/runtime/resumeCapabilities';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { ExistingSessionAutomationAvailability } from '@/components/sessions/authoring/context/sessionAuthoringContext';

function normalizeMachineId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveExistingSessionAutomationAvailability(params: Readonly<{
    session: Session | null | undefined;
    machineIdOverride?: string | null;
    sessionDekBase64?: string | null;
    accountSettings?: Record<string, unknown> | null;
}>): ExistingSessionAutomationAvailability {
    if (!params.session) {
        return { kind: 'blocked', reason: 'session_not_found' };
    }

    const machineId = normalizeMachineId(params.machineIdOverride ?? params.session.metadata?.machineId);
    if (!machineId) {
        return { kind: 'blocked', reason: 'machine_id_missing' };
    }

    if (params.session.encryptionMode !== 'plain' && !normalizeMachineId(params.sessionDekBase64)) {
        return { kind: 'blocked', reason: 'resume_key_missing' };
    }

    if (!canResumeSessionWithOptions(params.session.metadata, { accountSettings: params.accountSettings ?? null })) {
        return { kind: 'blocked', reason: 'session_not_eligible' };
    }

    return {
        kind: 'ready',
        machineId,
    };
}
