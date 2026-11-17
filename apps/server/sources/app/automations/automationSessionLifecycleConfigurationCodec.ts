import { AutomationSessionLifecycleConfigurationSchema, AutomationSessionLifecycleEventsSchema, canonicalizeAutomationSessionLifecycleEvents, initialAutomationSessionLifecycleRemainingOccurrences } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import { AutomationSessionLifecycleStructuralTriggerSchema, type AutomationSessionLifecycleStructuralTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';

type SessionLifecycleConfigurationRow = Readonly<{
    sessionLifecycleEventsJson: string | null;
    sessionLifecyclePolicyKind: 'currentTurn' | 'firstMatch' | 'nextMatches' | 'everyMatch' | null;
    sessionLifecycleMatchCount: number | null;
    remainingOccurrences: number | null;
    subjectKind: string | null;
    subjectKey: string | null;
    sourceSessionId: string | null;
    sourceTurnId: string | null;
}>;

export type StoredAutomationSessionLifecycleConfiguration = Readonly<{
    definition: AutomationSessionLifecycleStructuralTrigger;
    remainingOccurrences: number | null;
}>;

/** The sole physical trigger-row decoder for Session lifecycle configuration. */
export function decodeAutomationSessionLifecycleConfiguration(
    row: SessionLifecycleConfigurationRow,
): StoredAutomationSessionLifecycleConfiguration {
    const events = AutomationSessionLifecycleEventsSchema.parse(
        JSON.parse(required(row.sessionLifecycleEventsJson, 'sessionLifecycleEventsJson')),
    );
    const policy = decodePolicy(row);
    const definition = AutomationSessionLifecycleStructuralTriggerSchema.parse({
        kind: 'sessionLifecycle',
        ...(row.subjectKind === null ? {} : { subjectKind: row.subjectKind }),
        ...(row.subjectKey === null ? {} : { subjectKey: row.subjectKey }),
        ...(policy.kind !== 'currentTurn' || row.sourceSessionId === null ? {} : { sourceSessionId: row.sourceSessionId }),
        events: canonicalizeAutomationSessionLifecycleEvents(events),
        policy,
    });
    if (definition.policy.kind === 'currentTurn'
        && (definition.subjectKind !== 'session' || !definition.subjectKey || !definition.sourceSessionId)) {
        throw new Error('Automation Session lifecycle currentTurn trigger has no exact Session witness');
    }
    const initial = initialAutomationSessionLifecycleRemainingOccurrences(definition.policy);
    const remaining = row.remainingOccurrences;
    if (initial === null ? remaining !== null : remaining === null || remaining < 0 || remaining > initial) {
        throw new Error('Automation Session lifecycle trigger has invalid remainingOccurrences');
    }
    return { definition, remainingOccurrences: remaining };
}

/** The sole Session lifecycle matching-header to row encoder. */
export function encodeAutomationSessionLifecycleConfiguration(
    definitionInput: AutomationSessionLifecycleStructuralTrigger,
) {
    const definition = AutomationSessionLifecycleStructuralTriggerSchema.parse(definitionInput);
    return {
        sessionLifecycleEventsJson: JSON.stringify(canonicalizeAutomationSessionLifecycleEvents(definition.events)),
        sessionLifecyclePolicyKind: definition.policy.kind,
        sessionLifecycleMatchCount: definition.policy.kind === 'nextMatches' ? definition.policy.count : null,
        remainingOccurrences: initialAutomationSessionLifecycleRemainingOccurrences(definition.policy),
        subjectKind: definition.subjectKind ?? null,
        subjectKey: definition.subjectKey ?? null,
        sourceSessionId: definition.policy.kind === 'currentTurn' ? definition.sourceSessionId ?? null : null,
        sourceTurnId: definition.policy.kind === 'currentTurn' ? definition.policy.sourceTurnId : null,
    } as const;
}

/** Enablement and Event order do not create another registration. */
export function automationSessionLifecycleConfigurationsEqual(
    left: SessionLifecycleConfigurationRow,
    right: AutomationSessionLifecycleStructuralTrigger,
): boolean {
    try {
        return JSON.stringify(encodeAutomationSessionLifecycleConfiguration(
            decodeAutomationSessionLifecycleConfiguration(left).definition,
        )) === JSON.stringify(encodeAutomationSessionLifecycleConfiguration(right));
    } catch {
        return false;
    }
}

/** Selection edits preserve consumed counts; only a changed policy starts a new budget. */
export function automationSessionLifecyclePoliciesEqual(
    left: SessionLifecycleConfigurationRow,
    right: AutomationSessionLifecycleStructuralTrigger,
): boolean {
    try {
        return JSON.stringify(decodeAutomationSessionLifecycleConfiguration(left).definition.policy)
            === JSON.stringify(right.policy);
    } catch {
        return false;
    }
}

/** One-time retained 0.3 migration only; current readers never infer a selection. */
export function reconstructAutomationSessionLifecycleLegacySelection(
    row: Pick<SessionLifecycleConfigurationRow, 'sessionLifecycleEventsJson' | 'sessionLifecyclePolicyKind'
        | 'sessionLifecycleMatchCount' | 'remainingOccurrences' | 'sourceSessionId' | 'sourceTurnId'>,
    serverId: string,
) {
    return AutomationSessionLifecycleConfigurationSchema.parse({
        subject: { kind: 'session', serverId, sessionId: required(row.sourceSessionId, 'sourceSessionId') },
        events: canonicalizeAutomationSessionLifecycleEvents(AutomationSessionLifecycleEventsSchema.parse(
            JSON.parse(required(row.sessionLifecycleEventsJson, 'sessionLifecycleEventsJson')),
        )),
        policy: decodePolicy(row),
    });
}

function decodePolicy(row: Pick<SessionLifecycleConfigurationRow,
    'sessionLifecyclePolicyKind' | 'sessionLifecycleMatchCount' | 'sourceTurnId'>) {
    const kind = required(row.sessionLifecyclePolicyKind, 'sessionLifecyclePolicyKind');
    return kind === 'currentTurn'
        ? { kind, sourceTurnId: required(row.sourceTurnId, 'sourceTurnId') } as const
        : kind === 'nextMatches'
            ? { kind, count: required(row.sessionLifecycleMatchCount, 'sessionLifecycleMatchCount') } as const
            : { kind } as const;
}

function required<T>(value: T | null, field: string): T {
    if (value === null) throw new Error(`Automation Session lifecycle trigger has no ${field}`);
    return value;
}
