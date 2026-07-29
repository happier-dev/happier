import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agent-runtime';

type NativeInputAcceptedEvent = Extract<
    AgentSessionRuntimeEvent,
    Readonly<{ kind: 'input-accepted' }>
>;
type NativeInputRejectedEvent = Extract<
    AgentSessionRuntimeEvent,
    Readonly<{ kind: 'input-rejected' }>
>;
type NativeInputCustodyUnknownEvent = Extract<
    AgentSessionRuntimeEvent,
    Readonly<{ kind: 'input-custody-unknown' }>
>;
type NativeInputDeliveryFailedEvent = Extract<
    AgentSessionRuntimeEvent,
    Readonly<{ kind: 'input-delivery-failed' }>
>;

type RuntimeExactProviderInputOutcomeBase = Readonly<{
    localInputId: string;
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type RuntimeExactProviderInputOutcome =
    | (RuntimeExactProviderInputOutcomeBase & Readonly<{
        type: 'input-accepted';
        delivery: NativeInputAcceptedEvent['delivery'];
    }>)
    | (RuntimeExactProviderInputOutcomeBase & Readonly<{
        type: 'input-rejected';
        diagnostic: NativeInputRejectedEvent['diagnostic'];
        retryable: NativeInputRejectedEvent['retryable'];
    }>)
    | (RuntimeExactProviderInputOutcomeBase & Readonly<{
        type: 'input-custody-unknown';
        issue: NativeInputCustodyUnknownEvent['issue'];
    }>)
    | (RuntimeExactProviderInputOutcomeBase & Readonly<{
        type: 'input-delivery-failed';
        delivery: NativeInputDeliveryFailedEvent['delivery'];
        issue: NativeInputDeliveryFailedEvent['issue'];
        duplicateRisk: NativeInputDeliveryFailedEvent['duplicateRisk'];
    }>);

type RuntimeAcceptedOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-accepted' }>>;
type RuntimeRejectedOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-rejected' }>>;
type RuntimeCustodyUnknownOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-custody-unknown' }>>;
type RuntimeDeliveryFailedOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-delivery-failed' }>>;

type SessionProviderInputOutcomeIdentity = Readonly<{
    localId: string;
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type SessionProviderInputRejectedBeforeEffectReason =
    | 'provider_rejected_before_acceptance'
    | 'terminal_composer_draft'
    | 'runtime_config_blocked'
    | 'provider_unavailable_before_acceptance'
    | 'unsupported_action';

export function isReversibleSessionProviderInputBlockReason(
    reason: SessionProviderInputRejectedBeforeEffectReason,
): boolean {
    return reason === 'terminal_composer_draft'
        || reason === 'runtime_config_blocked'
        || reason === 'provider_unavailable_before_acceptance';
}

function readSessionProviderInputRejectedBeforeEffectReason(
    value: unknown,
): SessionProviderInputRejectedBeforeEffectReason {
    return value === 'terminal_composer_draft'
        || value === 'runtime_config_blocked'
        || value === 'provider_unavailable_before_acceptance'
        || value === 'unsupported_action'
        ? value
        : 'provider_rejected_before_acceptance';
}

/**
 * Host-owned semantic outcome vocabulary shared with Remote. Plugin Platform's native `input-*`
 * event names remain at the plugin boundary; exact provider correlation is retained here when the
 * native event carries it.
 */
export type SessionProviderInputOutcome =
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'accepted';
        providerTurnId?: string;
        providerDeliveryKind?: RuntimeAcceptedOutcome['delivery']['kind'];
        appliedModel?: Readonly<{
            provider: string;
            selection: ProviderBoundModelRef;
        }>;
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'rejected_before_effect';
        reason: SessionProviderInputRejectedBeforeEffectReason;
        diagnostic: RuntimeRejectedOutcome['diagnostic'];
        retryable: RuntimeRejectedOutcome['retryable'];
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'effect_may_have_occurred';
        issue: RuntimeCustodyUnknownOutcome['issue'];
        detail?: string;
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'effect_may_have_occurred';
        providerTurnId: string;
        providerDeliveryKind: RuntimeDeliveryFailedOutcome['delivery']['kind'];
        issue: RuntimeDeliveryFailedOutcome['issue'];
        duplicateRisk: RuntimeDeliveryFailedOutcome['duplicateRisk'];
        detail?: string;
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'custody_observed';
        detail?: string;
    }>);

type HostMappedExactProviderInputOutcome = RuntimeExactProviderInputOutcome extends infer Outcome
    ? Outcome extends Readonly<{ localInputId: string }>
        ? Omit<Outcome, 'localInputId'> & Readonly<{ localId: string }>
        : never
    : never;

export type HostExactProviderInputOutcome =
    | RuntimeExactProviderInputOutcome
    | HostMappedExactProviderInputOutcome;

export type HostLegacyProviderInputOutcome = Readonly<{
    type: 'custody_observed' | 'provider_accepted' | 'rejected_before_write' | 'possible_write';
    localId?: string;
    localIds?: readonly string[];
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
    reason?: string;
}>;

export type HostProviderInputOutcomeEvidence =
    | HostExactProviderInputOutcome
    | HostLegacyProviderInputOutcome;

export type SessionProviderInputOutcomeTarget = Readonly<{
    sessionId: string;
    hasPendingProviderInput(localId: string): boolean;
    observeProviderInputSettlement(outcome: SessionProviderInputOutcome): void;
}>;

function readNonBlank(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readOpaqueNonBlank(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readOutcomeLocalIds(outcome: HostProviderInputOutcomeEvidence): readonly string[] {
    if ('localId' in outcome && typeof outcome.localId === 'string') return [outcome.localId];
    if ('localInputId' in outcome || 'localInputIds' in outcome) {
        const ids: string[] = [];
        const append = (value: unknown): void => {
            const localId = readOpaqueNonBlank(value);
            if (!localId || ids.includes(localId)) return;
            ids.push(localId);
        };
        append('localInputId' in outcome ? outcome.localInputId : undefined);
        const localInputIds = 'localInputIds' in outcome ? outcome.localInputIds ?? [] : [];
        for (const localId of localInputIds) append(localId);
        return ids;
    }
    return 'localIds' in outcome ? outcome.localIds ?? [] : [];
}

function readIdentity(outcome: HostProviderInputOutcomeEvidence): SessionProviderInputOutcomeIdentity | null {
    const localIds = readOutcomeLocalIds(outcome);
    if (localIds.length !== 1) return null;
    const localId = readOpaqueNonBlank(localIds[0]);
    if (!localId) return null;
    const userMessageSeq = Number.isSafeInteger(outcome.userMessageSeq) && outcome.userMessageSeq! >= 0
        ? outcome.userMessageSeq
        : null;
    const userMessageSeqs = (outcome.userMessageSeqs ?? [])
        .filter((seq, index, values) => Number.isSafeInteger(seq) && seq >= 0 && values.indexOf(seq) === index);
    return {
        localId,
        userMessageSeq,
        ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    };
}

export function normalizeHostProviderInputOutcome(
    outcome: HostProviderInputOutcomeEvidence,
): SessionProviderInputOutcome | null {
    const identity = readIdentity(outcome);
    if (!identity) return null;
    switch (outcome.type) {
        case 'input-accepted': {
            const providerTurnId = readNonBlank(outcome.delivery.turnId);
            if (!providerTurnId) return null;
            return {
                kind: 'accepted',
                ...identity,
                providerTurnId,
                providerDeliveryKind: outcome.delivery.kind,
            };
        }
        case 'input-rejected':
            return {
                kind: 'rejected_before_effect',
                ...identity,
                reason: 'provider_rejected_before_acceptance',
                diagnostic: outcome.diagnostic,
                retryable: outcome.retryable,
            };
        case 'input-custody-unknown':
            return {
                kind: 'effect_may_have_occurred',
                ...identity,
                issue: outcome.issue,
            };
        case 'input-delivery-failed': {
            const providerTurnId = readNonBlank(outcome.delivery.turnId);
            if (!providerTurnId) return null;
            return {
                kind: 'effect_may_have_occurred',
                ...identity,
                providerTurnId,
                providerDeliveryKind: outcome.delivery.kind,
                issue: outcome.issue,
                duplicateRisk: outcome.duplicateRisk,
            };
        }
        case 'provider_accepted':
            return { kind: 'accepted', ...identity };
        case 'rejected_before_write':
            const rejectionReason = readSessionProviderInputRejectedBeforeEffectReason(outcome.reason);
            return {
                kind: 'rejected_before_effect',
                ...identity,
                reason: rejectionReason,
                diagnostic: { code: outcome.reason ?? 'provider_rejected_before_acceptance', severity: 'error' },
                retryable: isReversibleSessionProviderInputBlockReason(rejectionReason),
            };
        case 'possible_write':
            return {
                kind: 'effect_may_have_occurred',
                ...identity,
                issue: { code: outcome.reason ?? 'provider_input_effect_may_have_occurred', severity: 'error' },
                ...(outcome.reason ? { detail: outcome.reason } : {}),
            };
        case 'custody_observed':
            return {
                kind: 'custody_observed',
                ...identity,
                ...(outcome.reason ? { detail: outcome.reason } : {}),
            };
    }
}

/**
 * The one Dev host normalizer. Provider adapters publish evidence; this owner validates exact
 * singleton identity and enforces monotonic settlement before forwarding to the current session.
 */
export function createSessionProviderInputOutcomeNormalizer(params: Readonly<{
    getTarget(): SessionProviderInputOutcomeTarget;
    takeAppliedModel?(localId: string): Readonly<{
        provider: string;
        selection: ProviderBoundModelRef;
    }> | null;
    discardAppliedModel?(localId: string): void;
}>): (outcome: HostProviderInputOutcomeEvidence) => void {
    const decisiveOutcomeBySessionAndLocalId = new Map<
        string,
        'accepted' | 'rejected_before_effect' | 'effect_may_have_occurred'
    >();
    const outcomeKey = (sessionId: string, localId: string): string => `${sessionId}\u0000${localId}`;

    return (evidence) => {
        const outcome = normalizeHostProviderInputOutcome(evidence);
        if (!outcome) return;
        const target = params.getTarget();
        if (!target.hasPendingProviderInput(outcome.localId)) return;
        const key = outcomeKey(target.sessionId, outcome.localId);
        const decisiveOutcome = decisiveOutcomeBySessionAndLocalId.get(key);
        if (decisiveOutcome === 'accepted' || decisiveOutcome === 'rejected_before_effect') return;
        if (decisiveOutcome === 'effect_may_have_occurred' && outcome.kind !== 'accepted') return;
        if (outcome.kind === 'custody_observed') return;
        if (
            outcome.kind === 'accepted'
            || outcome.kind === 'effect_may_have_occurred'
        ) {
            decisiveOutcomeBySessionAndLocalId.set(key, outcome.kind);
        } else if (
            outcome.kind === 'rejected_before_effect'
            && !isReversibleSessionProviderInputBlockReason(outcome.reason)
        ) {
            decisiveOutcomeBySessionAndLocalId.set(key, outcome.kind);
        }
        if (
            outcome.kind === 'rejected_before_effect'
            && !isReversibleSessionProviderInputBlockReason(outcome.reason)
        ) {
            params.discardAppliedModel?.(outcome.localId);
        }
        if (outcome.kind === 'accepted') {
            const appliedModel = params.takeAppliedModel?.(outcome.localId) ?? null;
            target.observeProviderInputSettlement(
                appliedModel ? { ...outcome, appliedModel } : outcome,
            );
            return;
        }
        target.observeProviderInputSettlement(outcome);
    };
}
