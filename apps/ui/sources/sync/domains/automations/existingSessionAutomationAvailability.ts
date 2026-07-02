import {
    evaluateExistingSessionAutomationEligibility,
    type ExistingSessionAutomationEligibility,
} from '@happier-dev/agents';

type ExistingSessionAutomationSession = Readonly<{
    id?: string;
    encryptionMode?: 'e2ee' | 'plain';
    metadata?: Record<string, unknown> | null;
}> | null | undefined;

export type ExistingSessionAutomationAvailability =
    | Readonly<{ kind: 'hydrating' }>
    | Readonly<{ kind: 'ready'; machineId: string; eligibility: ExistingSessionAutomationEligibility & { eligible: true } }>
    | Readonly<{ kind: 'blocked'; reason: 'session_not_found' }>
    | Readonly<{ kind: 'blocked'; reason: 'machine_id_missing' }>
    | Readonly<{
        kind: 'blocked';
        reason: 'session_not_eligible';
        eligibility: ExistingSessionAutomationEligibility & { eligible: false };
    }>
    | Readonly<{
        kind: 'blocked';
        reason: 'resume_key_missing';
        machineId: string;
        eligibility: ExistingSessionAutomationEligibility & { eligible: true };
    }>;

function normalizeMachineId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveExistingSessionAutomationAvailability(input: Readonly<{
    sessionHydrated: boolean;
    session: ExistingSessionAutomationSession;
    machineIdOverride?: string | null;
    sessionDekBase64: string | null | undefined;
    accountSettings?: Record<string, unknown> | null;
}>): ExistingSessionAutomationAvailability {
    if (!input.sessionHydrated) {
        return { kind: 'hydrating' };
    }

    if (!input.session) {
        return { kind: 'blocked', reason: 'session_not_found' };
    }

    const machineId = normalizeMachineId(input.machineIdOverride);
    if (!machineId) {
        return { kind: 'blocked', reason: 'machine_id_missing' };
    }

    const eligibility = evaluateExistingSessionAutomationEligibility({
        metadata: input.session.metadata,
        accountSettings: input.accountSettings ?? null,
    });
    if (!eligibility.eligible) {
        return {
            kind: 'blocked',
            reason: 'session_not_eligible',
            eligibility,
        };
    }

    const requiresDek = input.session.encryptionMode !== 'plain';
    if (requiresDek && !input.sessionDekBase64) {
        return {
            kind: 'blocked',
            reason: 'resume_key_missing',
            machineId,
            eligibility,
        };
    }

    return {
        kind: 'ready',
        machineId,
        eligibility,
    };
}
