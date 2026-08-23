import { isPluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';

import type { TriageEntrySessionIntentV1 } from '../sessions/entrySessionOrchestrator.js';

import { readExactKeys } from './storedValue.js';

/**
 * The sole `triage.agentSelection` owner: the agent — and optionally the model —
 * a Triage **Ask** or **Fix** start uses, read, validated and written in one
 * place.
 *
 * Absent is the normal state and it means exactly one thing: this intent has no
 * opinion, so the generic new-session flow keeps choosing the agent it would
 * have chosen anyway. Nothing here ever substitutes an agent for an unset or
 * unresolvable choice — a settings value that quietly became "whichever agent
 * was listed first" would route a person's Fix at a backend they never picked,
 * which is worse than having no setting at all.
 *
 * The selection is stored in the **host's own vocabulary**, never a Triage one.
 * `agentTargetKey` is the exact `backendTargetKey` the host's
 * `agents.backends.enabled` option source yields, and it is also verbatim what
 * the canonical `SessionModelSelectionV1.ref.agentTargetKey` requires
 * (`packages/protocol/src/providers/selection/v1.ts`). The model members are the
 * canonical ref's own members. Triage adds no id, no alias and no mapping table
 * of its own, so a stored choice cannot mean something different here than it
 * means to the Session creator.
 *
 * The agent's `{ pluginId, localId }` identity is deliberately **not** stored.
 * The host's inventory is the authority on which key is startable and what its
 * qualified identity is; caching that here would be a second catalog that goes
 * stale the moment an agent is disabled or uninstalled.
 * `agentSelectionChoices.ts` resolves a stored key against the live inventory.
 */

/** The one versioned Account Settings key this document owns. */
export const TRIAGE_AGENT_SELECTION_SETTING_ID_V1 = 'triage.agentSelection';

/**
 * Every bound below is the canonical contract this value must survive, not a
 * nearby number: an agent key or model the Session creator would refuse must be
 * refused here, at the moment the user picks it, rather than at the start they
 * were relying on.
 *
 * `ProviderAgentTargetKeySchema` and `ProviderConnectionIdSchema` are bounded
 * record keys of 256 characters; `ProviderModelIdSchema` is a bounded string of
 * 512 characters that additionally admits no whitespace
 * (`packages/protocol/src/providers/ids.ts`). Those per-member bounds also bound
 * the whole value: this key holds exactly two optional selections behind an
 * exact-keys parse, so there is no set to grow and no separate whole-value
 * ceiling to enforce.
 */
export const MAX_TRIAGE_AGENT_TARGET_KEY_LENGTH_V1 = 256;
export const MAX_TRIAGE_MODEL_ID_LENGTH_V1 = 512;
export const MAX_TRIAGE_PROVIDER_CONNECTION_ID_LENGTH_V1 = 256;

export type TriageAgentModelSelectionV1 = Readonly<{
    modelId: string;
    /** `null` is the native arm of the canonical ref; a string binds the model to one provider connection. */
    providerConnectionId: string | null;
    /** When the user chose this model, carried into the canonical selection unchanged. */
    updatedAt: number;
}>;

export type TriageAgentSelectionV1 = Readonly<{
    /** The exact key the host's own agent inventory yields; never a Triage alias. */
    agentTargetKey: string;
    /** `null` leaves the model to the chosen agent's own default. */
    model: TriageAgentModelSelectionV1 | null;
}>;

export type TriageAgentSelectionsSettingV1 = Readonly<{
    v: 1;
    ask: TriageAgentSelectionV1 | null;
    fix: TriageAgentSelectionV1 | null;
}>;

/** The parsed absence: both intents defer to the generic new-session flow. */
export const TRIAGE_NO_AGENT_SELECTIONS_V1: TriageAgentSelectionsSettingV1 = Object.freeze({
    v: 1,
    ask: null,
    fix: null,
});

/**
 * How a stored value was understood.
 *
 * `unreadable` is a real third answer, not a failure dressed as the default. A
 * value this build cannot parse belongs to a newer writer, and reporting it as
 * `absent` is what would let the next ordinary set destroy a choice the other
 * client can still read.
 */
export type TriageAgentSelectionsReadV1 = Readonly<{
    kind: 'absent' | 'parsed' | 'unreadable';
    value: TriageAgentSelectionsSettingV1;
}>;

export type TriageAgentSelectionRejectionV1 =
    | 'agentTargetKey'
    | 'model'
    | 'modelId'
    | 'providerConnectionId';

export type TriageAgentSelectionMutationResultV1 =
    | Readonly<{ status: 'applied'; value: TriageAgentSelectionsSettingV1 }>
    /** Another writer won; the caller re-reads rather than forcing its value. */
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unreadable' }>
    | Readonly<{ status: 'rejected'; reason: TriageAgentSelectionRejectionV1 }>;

/**
 * `model` is a required member of `set` on purpose.
 *
 * Choosing an agent and choosing a model are one settled decision, and an
 * optional member would let a caller that simply forgot it silently discard a
 * model the user had already picked.
 */
export type TriageAgentSelectionCommandV1 =
    | Readonly<{
        kind: 'set';
        intent: TriageEntrySessionIntentV1;
        agentTargetKey: string;
        model: TriageAgentModelSelectionV1 | null;
    }>
    | Readonly<{ kind: 'clear'; intent: TriageEntrySessionIntentV1 }>;

export type TriageAgentSelectionDepsV1 = Readonly<{
    settings: Pick<ScopedSettingsService, 'snapshot' | 'set'>;
    signal?: AbortSignal;
}>;

/** The canonical record keys no bounded key may be, mirrored from `canonicalRecordKey.ts`. */
const RESERVED_RECORD_KEYS: readonly string[] = Object.freeze(['__proto__', 'prototype', 'constructor']);

/** The canonical control-character refusal, mirrored from `canonicalBoundedStringSchema`. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * The canonical string rule: already trimmed and free of control characters, so
 * a value stored here is the same value the host will accept later.
 * Normalizing instead would rewrite an identifier that must round-trip verbatim.
 */
function readCanonicalString(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    if (value.length === 0 || value.length > maxLength) return null;
    if (value !== value.trim()) return null;
    return CONTROL_CHARACTERS.test(value) ? null : value;
}

function readCanonicalRecordKey(value: unknown, maxLength: number): string | null {
    const canonical = readCanonicalString(value, maxLength);
    return canonical === null || RESERVED_RECORD_KEYS.includes(canonical) ? null : canonical;
}

type ModelOutcome =
    | Readonly<{ ok: true; model: TriageAgentModelSelectionV1 | null }>
    | Readonly<{ ok: false; reason: TriageAgentSelectionRejectionV1 }>;

function readModel(raw: unknown): ModelOutcome {
    if (raw === null) return { ok: true, model: null };
    const candidate = readExactKeys(raw, ['modelId', 'providerConnectionId', 'updatedAt']);
    if (!candidate) return { ok: false, reason: 'model' };

    const modelId = readCanonicalString(candidate.modelId, MAX_TRIAGE_MODEL_ID_LENGTH_V1);
    if (modelId === null || /\s/u.test(modelId)) return { ok: false, reason: 'modelId' };

    const providerConnectionId = candidate.providerConnectionId === null
        ? null
        : readCanonicalRecordKey(candidate.providerConnectionId, MAX_TRIAGE_PROVIDER_CONNECTION_ID_LENGTH_V1);
    if (providerConnectionId === null && candidate.providerConnectionId !== null) {
        return { ok: false, reason: 'providerConnectionId' };
    }

    const updatedAt = candidate.updatedAt;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) {
        return { ok: false, reason: 'model' };
    }
    return { ok: true, model: { modelId, providerConnectionId, updatedAt } };
}

type SelectionOutcome =
    | Readonly<{ ok: true; selection: TriageAgentSelectionV1 }>
    | Readonly<{ ok: false; reason: TriageAgentSelectionRejectionV1 }>;

/**
 * Validate one selection. The same rules run for a stored value and for an
 * incoming command, so a selection that could not be written cannot be read
 * back either.
 */
function readSelection(raw: Readonly<{ agentTargetKey: unknown; model: unknown }>): SelectionOutcome {
    const agentTargetKey = readCanonicalRecordKey(raw.agentTargetKey, MAX_TRIAGE_AGENT_TARGET_KEY_LENGTH_V1);
    if (agentTargetKey === null) return { ok: false, reason: 'agentTargetKey' };
    const model = readModel(raw.model);
    if (!model.ok) return model;
    return { ok: true, selection: { agentTargetKey, model: model.model } };
}

function readStoredSelection(raw: unknown): SelectionOutcome | null {
    if (raw === null) return null;
    const candidate = readExactKeys(raw, ['agentTargetKey', 'model']);
    if (!candidate) return { ok: false, reason: 'agentTargetKey' };
    return readSelection({ agentTargetKey: candidate.agentTargetKey, model: candidate.model });
}

/**
 * Parse one stored value.
 *
 * Any member this build cannot understand makes the whole value `unreadable`
 * rather than dropping that intent: silently discarding one side would leave
 * the user's Fix pointed at the generic flow while their settings surface still
 * showed a choice, and there is no upstream owner to recover it from.
 */
export function parseTriageAgentSelections(raw: unknown): TriageAgentSelectionsReadV1 {
    if (raw === undefined || raw === null) {
        return { kind: 'absent', value: TRIAGE_NO_AGENT_SELECTIONS_V1 };
    }
    const unreadable: TriageAgentSelectionsReadV1 = {
        kind: 'unreadable',
        value: TRIAGE_NO_AGENT_SELECTIONS_V1,
    };
    const candidate = readExactKeys(raw, ['v', 'ask', 'fix']);
    if (!candidate || candidate.v !== 1) return unreadable;

    const ask = readStoredSelection(candidate.ask);
    if (ask && !ask.ok) return unreadable;
    const fix = readStoredSelection(candidate.fix);
    if (fix && !fix.ok) return unreadable;

    return {
        kind: 'parsed',
        value: {
            v: 1,
            ask: ask ? ask.selection : null,
            fix: fix ? fix.selection : null,
        },
    };
}

/**
 * Project the validated value to the exact JSON that is stored.
 *
 * The value is rebuilt member by member rather than passed through, so nothing
 * the validator did not admit can ride into durable Account state.
 */
function toStoredValue(value: TriageAgentSelectionsSettingV1): JsonValue {
    const selection = (entry: TriageAgentSelectionV1 | null): JsonValue => (entry === null ? null : {
        agentTargetKey: entry.agentTargetKey,
        model: entry.model === null ? null : {
            modelId: entry.model.modelId,
            providerConnectionId: entry.model.providerConnectionId,
            updatedAt: entry.model.updatedAt,
        },
    });
    return { v: 1, ask: selection(value.ask), fix: selection(value.fix) };
}

export async function readTriageAgentSelections(deps: Readonly<{
    settings: Pick<ScopedSettingsService, 'snapshot'>;
    signal?: AbortSignal;
}>): Promise<TriageAgentSelectionsReadV1 & Readonly<{ revision: string }>> {
    const snapshot = await deps.settings.snapshot(deps.signal ? { signal: deps.signal } : undefined);
    const read = parseTriageAgentSelections(snapshot.values[TRIAGE_AGENT_SELECTION_SETTING_ID_V1]);
    return { ...read, revision: snapshot.revision };
}

function applyCommand(
    current: TriageAgentSelectionsSettingV1,
    command: TriageAgentSelectionCommandV1,
): TriageAgentSelectionMutationResultV1 {
    if (command.kind === 'clear') {
        return {
            status: 'applied',
            value: { ...current, [command.intent]: null },
        };
    }
    const parsed = readSelection({ agentTargetKey: command.agentTargetKey, model: command.model });
    if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
    return {
        status: 'applied',
        // The other intent is carried through untouched: choosing an agent for
        // Ask must never disturb the one the user chose for Fix.
        value: { ...current, [command.intent]: parsed.selection },
    };
}

/**
 * The one typed set/clear write.
 *
 * It reads the authoritative record, validates the whole resulting value, and
 * writes it against the revision it read. A losing write returns the typed
 * `conflict` and the caller re-reads: there is no last-writer-wins merge and no
 * hidden local copy.
 *
 * `conflict` means exactly one thing — the host refused this write because
 * another writer moved the revision. Every other refusal the Settings service
 * raises, and an abort or a store failure, surfaces as itself: folding them all
 * into `conflict` would tell the user their choice changed elsewhere and to
 * retry, when the write is in fact refused for a reason retrying cannot resolve.
 */
export async function mutateTriageAgentSelection(
    deps: TriageAgentSelectionDepsV1,
    command: TriageAgentSelectionCommandV1,
): Promise<TriageAgentSelectionMutationResultV1> {
    const options = deps.signal ? { signal: deps.signal } : undefined;
    const snapshot = await deps.settings.snapshot(options);
    const read = parseTriageAgentSelections(snapshot.values[TRIAGE_AGENT_SELECTION_SETTING_ID_V1]);
    // Refusing here is what keeps a newer client's choice alive: this build
    // cannot merge into a value it cannot read, so it declines rather than
    // replacing it with its own idea of the selections.
    if (read.kind === 'unreadable') return { status: 'unreadable' };

    const applied = applyCommand(read.value, command);
    if (applied.status !== 'applied') return applied;

    try {
        await deps.settings.set(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, toStoredValue(applied.value), {
            expectedRevision: snapshot.revision,
            ...(deps.signal ? { signal: deps.signal } : {}),
        });
    } catch (error) {
        if (isPluginError(error) && error.code === 'plugin_settings_revision_conflict') {
            return { status: 'conflict' };
        }
        throw error;
    }
    return applied;
}
