import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PreDispatchInputRejectionCodeV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';

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
        acceptedAtMs?: number;
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
    }>)
    | (RuntimeExactProviderInputOutcomeBase & Readonly<{
        type: 'input-rejected-before-provider';
        reason: 'provider_unavailable_before_acceptance' | 'host_retired_before_dispatch';
        diagnostic: NativeInputRejectedEvent['diagnostic'];
        retryable: true;
        retireLocalCustodyAfterDurableBlock: true;
    }>);

type RuntimeAcceptedOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-accepted' }>>;
type RuntimeRejectedOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-rejected' }>>;
type RuntimeCustodyUnknownOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-custody-unknown' }>>;
type RuntimeDeliveryFailedOutcome = Extract<RuntimeExactProviderInputOutcome, Readonly<{ type: 'input-delivery-failed' }>>;

export type SessionProviderInputOutcomeIdentity = Readonly<{
    localId: string;
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type SessionProviderInputRejectedBeforeEffectReason =
    | 'provider_rejected_before_acceptance'
    | PreDispatchInputRejectionCodeV1
    | 'terminal_composer_draft'
    | 'runtime_config_blocked'
    | 'provider_unavailable_before_acceptance'
    | 'host_retired_before_dispatch'
    | 'steering_unavailable'
    | 'conditional_steer_unavailable'
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
    return value === 'permission_mode_not_granted'
        || value === 'terminal_composer_draft'
        || value === 'runtime_config_blocked'
        || value === 'provider_unavailable_before_acceptance'
        || value === 'host_retired_before_dispatch'
        || value === 'steering_unavailable'
        || value === 'conditional_steer_unavailable'
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
        acceptedAtMs?: number;
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'rejected_before_effect';
        reason: SessionProviderInputRejectedBeforeEffectReason;
        diagnostic: RuntimeRejectedOutcome['diagnostic'];
        retryable: RuntimeRejectedOutcome['retryable'];
        retireLocalCustodyAfterDurableBlock?: true;
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

/**
 * Whether a correlated listener can release its exact-input subscription. Ambiguous delivery and
 * retryable pre-effect rejection may still be upgraded by later exact provider acceptance.
 */
export function isSessionProviderInputOutcomeTerminal(
    outcome: SessionProviderInputOutcome,
): outcome is Extract<
    SessionProviderInputOutcome,
    Readonly<{ kind: 'accepted' | 'rejected_before_effect' }>
> {
    return outcome.kind === 'accepted'
        || (outcome.kind === 'rejected_before_effect' && !outcome.retryable);
}

type HostMappedExactProviderInputOutcome = RuntimeExactProviderInputOutcome extends infer Outcome
    ? Outcome extends Readonly<{ localInputId: string }>
        ? Omit<Outcome, 'localInputId'> & Readonly<{ localId: string }>
        : never
    : never;

export type HostExactProviderInputOutcome =
    | RuntimeExactProviderInputOutcome
    | HostMappedExactProviderInputOutcome;

/** Host-owned evidence produced before exact provider delivery is available. */
export type HostLocalProviderInputOutcome = Readonly<{
    type: 'custody_observed' | 'rejected_before_write' | 'possible_write';
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
    | HostLocalProviderInputOutcome;

export type SessionProviderInputOutcomePort = Readonly<{
    setOnPromptDeliveryOutcome(handler: ((outcome: HostProviderInputOutcomeEvidence) => void) | null): void;
    setOnPromptTerminallyRejectedBeforeProvider?(handler: ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq: number | null;
        userMessageSeqs?: readonly number[];
        deliveryBlockedReason?: string;
    }>) => void) | null): void;
    setOnPromptDeliveryBlockerCleared?(handler: ((info: Readonly<{
        deliveryBlockedReason?: string;
    }>) => void) | null): void;
}>;

/** Bind the admitted runtime's evidence to the host's existing Pending normalizer. */
export function bindSessionProviderInputOutcome(params: Readonly<{
    runtime: SessionProviderInputOutcomePort;
    observe(outcome: HostProviderInputOutcomeEvidence): void;
    wakePendingMaterialization(): void;
}>): () => void {
    params.runtime.setOnPromptDeliveryOutcome(params.observe);
    params.runtime.setOnPromptTerminallyRejectedBeforeProvider?.((info) => {
        params.observe({
            type: 'rejected_before_write',
            ...info,
            ...(info.deliveryBlockedReason ? { reason: info.deliveryBlockedReason } : {}),
        });
    });
    params.runtime.setOnPromptDeliveryBlockerCleared?.(() => params.wakePendingMaterialization());
    return () => {
        params.runtime.setOnPromptDeliveryOutcome(null);
        params.runtime.setOnPromptTerminallyRejectedBeforeProvider?.(null);
        params.runtime.setOnPromptDeliveryBlockerCleared?.(null);
    };
}

/**
 * The durable, restart-surviving answer to "did the provider durably accept this exact Pending
 * input?". It is derived from the Pending owner's existing durable delivery state, not from a
 * second acceptance record, and `unknown` means that state could not be read — never that the
 * input was or was not accepted.
 */
export type DurableProviderInputAcceptanceV1 = 'accepted' | 'not_accepted' | 'unknown';

export type SessionProviderInputOutcomeTarget = Readonly<{
    sessionId: string;
    hasPendingProviderInput(localId: string): boolean;
    observeProviderInputSettlement(outcome: SessionProviderInputOutcome): void | Promise<boolean | void>;
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
                ...(Number.isSafeInteger(outcome.acceptedAtMs) && outcome.acceptedAtMs! >= 0
                    ? { acceptedAtMs: outcome.acceptedAtMs } : {}),
            };
        }
        case 'input-rejected':
            return {
                kind: 'rejected_before_effect',
                ...identity,
                reason: outcome.retryable ? 'provider_unavailable_before_acceptance' : 'provider_rejected_before_acceptance',
                diagnostic: outcome.diagnostic,
                retryable: outcome.retryable,
            };
        case 'input-rejected-before-provider':
            return {
                kind: 'rejected_before_effect',
                ...identity,
                reason: outcome.reason,
                diagnostic: outcome.diagnostic,
                retryable: outcome.retryable,
                retireLocalCustodyAfterDurableBlock:
                    outcome.retireLocalCustodyAfterDurableBlock,
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
    return null;
}

/**
 * The one Dev host normalizer. Provider adapters publish evidence; this owner validates exact
 * singleton identity and enforces monotonic settlement before forwarding the same accepted fact
 * to Pending and any correlated host effect.
 */
export function createSessionProviderInputOutcomeNormalizer(params: Readonly<{
    getTarget(): SessionProviderInputOutcomeTarget;
    /** Exact retained inputs actually represented by this host-prepared dispatch. */
    readRepresentedPendingInputs?(localId: string): readonly SessionProviderInputOutcomeIdentity[];
    observeAcceptedEffect?(localId: string, pendingSettlement?: Promise<void>): void;
    discardAcceptedEffect?(localId: string): void;
}>): (outcome: HostProviderInputOutcomeEvidence) => void {
    const decisiveOutcomeBySessionAndLocalId = new Map<
        string,
        'accepted' | 'rejected_before_effect' | 'effect_may_have_occurred'
    >();
    const outcomeKey = (sessionId: string, localId: string): string => `${sessionId}\u0000${localId}`;

    const observeNormalized = (
        outcome: SessionProviderInputOutcome,
        target: SessionProviderInputOutcomeTarget,
        precedingSettlement?: Promise<void>,
    ): Promise<void> | undefined => {
        if (!target.hasPendingProviderInput(outcome.localId)) {
            if (outcome.kind === 'accepted') {
                // Context-only host effects, such as a committed Follow wake event, deliberately
                // have no Pending user-input row. The exact-id registry remains the authority:
                // an unregistered provider id is a no-op and cannot manufacture an effect.
                if (precedingSettlement) params.observeAcceptedEffect?.(outcome.localId, precedingSettlement);
                else params.observeAcceptedEffect?.(outcome.localId);
            } else if (
                outcome.kind === 'rejected_before_effect'
                && isSessionProviderInputOutcomeTerminal(outcome)
            ) {
                params.discardAcceptedEffect?.(outcome.localId);
            }
            return precedingSettlement;
        }
        const key = outcomeKey(target.sessionId, outcome.localId);
        const decisiveOutcome = decisiveOutcomeBySessionAndLocalId.get(key);
        if (decisiveOutcome === 'accepted' || decisiveOutcome === 'rejected_before_effect') return;
        if (decisiveOutcome === 'effect_may_have_occurred' && outcome.kind !== 'accepted') return;
        if (outcome.kind === 'custody_observed') return;
        if (isSessionProviderInputOutcomeTerminal(outcome)) {
            decisiveOutcomeBySessionAndLocalId.set(key, outcome.kind);
        } else if (outcome.kind === 'effect_may_have_occurred') {
            decisiveOutcomeBySessionAndLocalId.set(key, outcome.kind);
        }
        if (
            outcome.kind === 'rejected_before_effect'
            && isSessionProviderInputOutcomeTerminal(outcome)
        ) {
            params.discardAcceptedEffect?.(outcome.localId);
        }
        if (outcome.kind === 'accepted') {
            let settlement: void | Promise<boolean | void>;
            try {
                settlement = precedingSettlement
                    ? precedingSettlement.then(() => target.observeProviderInputSettlement(outcome))
                    : target.observeProviderInputSettlement(outcome);
            } catch (error) {
                params.observeAcceptedEffect?.(outcome.localId);
                throw error;
            }
            // Native acceptance retires replay custody immediately. Follow
            // receives the existing Pending write to join before its own ACK;
            // the server still verifies durability if that write fails.
            const pendingSettlement = settlement ? settlement.then(
                () => undefined,
                () => undefined,
            ) : undefined;
            if (pendingSettlement) params.observeAcceptedEffect?.(outcome.localId, pendingSettlement);
            else params.observeAcceptedEffect?.(outcome.localId);
            return pendingSettlement;
        }
        target.observeProviderInputSettlement(outcome);
        return undefined;
    };

    return (evidence) => {
        const outcome = normalizeHostProviderInputOutcome(evidence);
        if (!outcome) return;
        const target = params.getTarget();
        // The native adapter still proves exactly one primary input. The host
        // alone knows which retained originals its final prompt represented.
        // Reuse the same delivery fact and Pending writer, without making those
        // originals additional Turn/permission witnesses.
        const represented = [...params.readRepresentedPendingInputs?.(outcome.localId) ?? []]
            .sort((left, right) => (left.userMessageSeq ?? Number.MAX_SAFE_INTEGER)
                - (right.userMessageSeq ?? Number.MAX_SAFE_INTEGER));
        const seen = new Set([outcome.localId]);
        let precedingSettlement: Promise<void> | undefined;
        for (const input of represented) {
            if (seen.has(input.localId)) continue;
            seen.add(input.localId);
            precedingSettlement = observeNormalized({ ...outcome, ...input,
                userMessageSeqs: input.userMessageSeqs }, target, precedingSettlement) ?? precedingSettlement;
        }
        observeNormalized(outcome, target, precedingSettlement);
    };
}

export type RegisterProviderAcceptedEffect = (
    localId: string,
    onAccepted: ((pendingSettlement?: Promise<void>) => void) | null,
    representedInputs?: readonly SessionProviderInputOutcomeIdentity[],
) => void;

/** The Session host's single exact-input effect registry and outcome binding. */
export function createSessionProviderInputOutcomeBinding(params: Omit<
    Parameters<typeof createSessionProviderInputOutcomeNormalizer>[0],
    'observeAcceptedEffect' | 'discardAcceptedEffect' | 'readRepresentedPendingInputs'
>): Readonly<{
    registerProviderAcceptedEffect: RegisterProviderAcceptedEffect;
    observeProviderInputOutcome: ReturnType<typeof createSessionProviderInputOutcomeNormalizer>;
    clearAcceptedEffects(): void;
}> {
    const acceptedEffects = new Map<string, {
        effects: Array<(pendingSettlement?: Promise<void>) => void>;
        representedInputs: readonly SessionProviderInputOutcomeIdentity[];
    }>();
    const registerProviderAcceptedEffect: RegisterProviderAcceptedEffect = (localId, onAccepted, representedInputs) => {
        if (!onAccepted && !representedInputs?.length) {
            acceptedEffects.delete(localId);
            return;
        }
        const entry = acceptedEffects.get(localId) ?? { effects: [], representedInputs: [] };
        if (onAccepted) entry.effects.push(onAccepted);
        else entry.effects = [];
        if (representedInputs) entry.representedInputs = representedInputs.map(input => ({ ...input,
            ...(input.userMessageSeqs ? { userMessageSeqs: [...input.userMessageSeqs] } : {}) }));
        acceptedEffects.set(localId, entry);
    };
    const observeProviderInputOutcome = createSessionProviderInputOutcomeNormalizer({
        ...params,
        readRepresentedPendingInputs: localId => acceptedEffects.get(localId)?.representedInputs ?? [],
        observeAcceptedEffect: (localId, pendingSettlement) => {
            const entry = acceptedEffects.get(localId);
            if (!entry) return;
            acceptedEffects.delete(localId);
            for (const effect of entry.effects) {
                try { effect(pendingSettlement); }
                catch { /* One host effect cannot invalidate authoritative acceptance or another effect. */ }
            }
        },
        discardAcceptedEffect: localId => { acceptedEffects.delete(localId); },
    });
    return { registerProviderAcceptedEffect, observeProviderInputOutcome,
        clearAcceptedEffects: () => { acceptedEffects.clear(); } };
}
