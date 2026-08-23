import { isPluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1,
    normalizeTriageSingleLineV1,
    type TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import {
    TRIAGE_WORKSPACE_MODES_V1,
    type TriageWorkspaceModeV1,
} from '../sessions/entrySessionWorkspace.js';
import { readExactKeys } from './storedValue.js';

/**
 * The sole `triage.actions` owner: the configurable set of things a reader can
 * start from an entry, read, validated and written in one place.
 *
 * An action is a **composition record**, not a workflow. It answers five
 * questions and delegates everything else to an owner that already exists:
 *
 *  - `appliesTo` — which subjects it is offered on;
 *  - `profileId` — which Launch Profile supplies the Session defaults;
 *  - `promptInvocationToken` — which Prompt Library invocation supplies the task
 *    instruction;
 *  - `workspaceMode` — what the start needs materialized;
 *  - `delivery` — whether the resolved prompt is composed or sent.
 *
 * There are no condition graphs, steps, retries, variables, branching, hooks or
 * post-action pipelines, and there is no place to add one: every member above is
 * a reference or a closed vocabulary, so an action can only ever name an owner,
 * never encode behaviour of its own.
 *
 * **Ask, Fix and Review are configuration, not protocol literals.** They ship as
 * `TRIAGE_DEFAULT_ACTIONS_V1`, which is what an *absent* value reads as — the
 * headline controls therefore exist with zero writes, and a person who renames
 * Ask to "Discuss" or deletes Fix gets exactly that, because a parsed empty set
 * is a different answer from an absent one.
 *
 * **Neither the agent nor the model is a member.** `LaunchProfileV2` already owns
 * `preferredAgentTargetKey`, `preferredModelSelection`, permission and
 * persistence by target, and environment. The retired `triage.agentSelection`
 * stored the same agent and model per intent, which was one concept with two
 * owners; this record names a profile instead.
 *
 * **Review has two arms and its label decides nothing.** `target` is an explicit
 * member: an `agent` action starts a Session and hands the agent a prompt, while
 * a `reviewStart` action targets the incumbent `review.start` contract with its
 * own engines and scope. Renaming either one changes nothing about which arm
 * runs.
 */

/** The one versioned Account Settings key this document owns. */
export const TRIAGE_ACTIONS_SETTING_ID_V1 = 'triage.actions';

/** At most this many actions: this is one Settings value, not one field per action. */
export const MAX_TRIAGE_ACTIONS_V1 = 32;
/** Label bound, measured in UTF-8 bytes after trimming, not in characters. */
export const MAX_TRIAGE_ACTION_LABEL_UTF8_BYTES_V1 = 64;
/**
 * `LaunchProfileV2.id` is bounded at 256 characters
 * (`packages/protocol/src/profiles/v2/schema.ts`); a profile id this record
 * would accept but the profile owner would refuse could never resolve.
 */
export const MAX_TRIAGE_ACTION_PROFILE_ID_LENGTH_V1 = 256;
/**
 * The whole serialized `triage.actions` value, measured over the complete value
 * rather than per member, because a set of individually valid actions is exactly
 * how a Settings record overflows.
 */
export const MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 = 64 * 1024;

/**
 * What a start needs materialized, in the orchestrator's own three pairings.
 *
 * These are the three cases the retired `ask | fix` union decided implicitly:
 * ask never materialized a workspace, a pull-request fix demanded a prepared
 * review workspace, and every other fix ran in the selected project. Naming them
 * directly is what lets the action's declared mode BE the request instead of
 * being restated at the gate.
 */
export type TriageActionWorkspaceModeV1 = TriageWorkspaceModeV1;

/** Whether the resolved prompt lands in the composer or is sent immediately. */
export const TRIAGE_ACTION_DELIVERIES_V1 = ['compose', 'send'] as const;
export type TriageActionDeliveryV1 = (typeof TRIAGE_ACTION_DELIVERIES_V1)[number];

/**
 * Which arm the action runs, stated rather than inferred.
 *
 * `promptInvocationToken` is the Prompt Library's own public handle — the token
 * a person types in a composer — and it is stored as a reference, never as a
 * copied body: Triage holds no prompt text, so editing the prompt in the Library
 * changes what every action using it sends.
 *
 * `delivery` is meaningful with or without a prompt. With one it says whether
 * the body is composed or sent; without one it says whether the Session opens
 * with the entry attached and waiting, or sends that attachment straight away.
 */
export type TriageActionTargetV1 =
    | Readonly<{
        kind: 'agent';
        promptInvocationToken: string | null;
        delivery: TriageActionDeliveryV1;
    }>
    /** The incumbent `review.start` contract owns its engines and its scope. */
    | Readonly<{ kind: 'reviewStart' }>;

export type TriageActionV1 = Readonly<{
    /** Stable within the Account; the three seeded actions carry literal ids. */
    actionId: string;
    label: string;
    /** A disabled action is retained and configured, and is offered nowhere. */
    enabled: boolean;
    /** Non-empty: an action offered on no subject could never be pressed. */
    appliesTo: readonly TriageSourceWorkflowSubjectV1[];
    /** `null` lets the generic new-Session flow choose, exactly as it does today. */
    profileId: string | null;
    workspaceMode: TriageActionWorkspaceModeV1;
    target: TriageActionTargetV1;
}>;

export type TriageActionsSettingV1 = Readonly<{
    v: 1;
    /** Array order is display order; reordering is a first-class write. */
    actions: readonly TriageActionV1[];
}>;

const ALL_SUBJECTS: readonly TriageSourceWorkflowSubjectV1[] =
    Object.freeze([...TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1]);

/**
 * The shipped seed.
 *
 * Ask and Fix carry the two pairings the retired intent union expressed for
 * every subject, and Review is the pull-request arm that reaches the incumbent
 * `review.start` contract — the one capability no agent action can stand in for.
 * "Review with agent" is not seeded because it is an ordinary agent action a
 * person composes from the same five answers; seeding it would imply the two
 * arms are one control with a mode.
 */
export const TRIAGE_DEFAULT_ACTIONS_V1: readonly TriageActionV1[] = Object.freeze([
    Object.freeze({
        actionId: 'ask',
        label: 'Ask',
        enabled: true,
        appliesTo: ALL_SUBJECTS,
        profileId: null,
        workspaceMode: 'reference_only',
        target: Object.freeze({ kind: 'agent', promptInvocationToken: null, delivery: 'compose' }),
    }),
    Object.freeze({
        actionId: 'fix',
        label: 'Fix',
        enabled: true,
        appliesTo: ALL_SUBJECTS,
        profileId: null,
        workspaceMode: 'repository',
        target: Object.freeze({ kind: 'agent', promptInvocationToken: null, delivery: 'compose' }),
    }),
    Object.freeze({
        actionId: 'review',
        label: 'Review',
        enabled: true,
        appliesTo: Object.freeze(['pullRequest'] as const),
        profileId: null,
        workspaceMode: 'pull_request',
        target: Object.freeze({ kind: 'reviewStart' }),
    }),
] as readonly TriageActionV1[]);

/**
 * The ONE offered-action decision.
 *
 * It takes no layout, no mount, no platform and no source body — which is why
 * the same set renders in the wide split composition and the compact stacked
 * one, and why a source's own detail body can never add or remove a control.
 * Declared order is preserved: reordering is a person's configuration, not a
 * rule this function reapplies.
 *
 * A disabled action is retained and configured and is offered nowhere, so the
 * filter is the two members that decide it and nothing else. There is no
 * subject-to-mode derivation left here: the action's declared `workspaceMode`
 * IS the request its press makes.
 */
export function planTriageOfferedActionsV1(
    actions: readonly TriageActionV1[],
    workflowSubject: TriageSourceWorkflowSubjectV1,
): readonly TriageActionV1[] {
    return actions.filter(
        (action) => action.enabled && action.appliesTo.includes(workflowSubject),
    );
}

/**
 * The translation key of a control still showing its shipped words.
 *
 * A label a person may rewrite cannot carry a translation key — their words are
 * their words in every locale. The three seeded labels are not that: until
 * somebody edits one it is Happier's own copy, and rendering `Ask` untranslated
 * on ten locales to buy configurability would be a capability lost for nothing.
 * So the key is resolved from the stored record rather than stored in it: a
 * seeded id whose label is still the seeded label translates, and the first
 * rename ends that for exactly that action.
 */
const SEEDED_ACTION_TITLE_KEYS_V1: Readonly<Record<string, string>> = Object.freeze({
    ask: 'plugins.triage.surface.session.ask',
    fix: 'plugins.triage.surface.session.fix',
    review: 'plugins.triage.surface.session.review',
});

export function readTriageActionTitleKeyV1(action: TriageActionV1): string | null {
    const seeded = TRIAGE_DEFAULT_ACTIONS_V1.find(
        (candidate) => candidate.actionId === action.actionId,
    );
    if (seeded === undefined || seeded.label !== action.label) return null;
    return SEEDED_ACTION_TITLE_KEYS_V1[action.actionId] ?? null;
}

/** The parsed absence: the seed, which needs no write to exist. */
export const TRIAGE_SEEDED_ACTIONS_V1: TriageActionsSettingV1 = Object.freeze({
    v: 1,
    actions: TRIAGE_DEFAULT_ACTIONS_V1,
});

/**
 * How a stored value was understood.
 *
 * `unreadable` is a real third answer, not a failure dressed as the seed. A
 * value this build cannot parse belongs to a newer writer, and reporting it as
 * `absent` is what would let the next ordinary write replace a configured
 * catalogue the other client can still read.
 */
export type TriageActionsReadV1 = Readonly<{
    kind: 'absent' | 'parsed' | 'unreadable';
    value: TriageActionsSettingV1;
}>;

export type TriageActionsRejectionV1 =
    | 'actionId'
    | 'label'
    | 'enabled'
    | 'appliesTo'
    | 'duplicateSubject'
    | 'profileId'
    | 'workspaceMode'
    | 'target'
    | 'promptInvocationToken'
    | 'delivery'
    | 'reorder'
    | 'actionLimit'
    | 'valueTooLarge';

export type TriageActionsMutationResultV1 =
    | Readonly<{ status: 'applied'; actionId: string | null; value: TriageActionsSettingV1 }>
    /** Another writer won; the caller re-reads rather than forcing its value. */
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unknownAction' }>
    | Readonly<{ status: 'unreadable' }>
    | Readonly<{ status: 'rejected'; reason: TriageActionsRejectionV1 }>;

/** Everything an action is, minus the identity the writer owns. */
export type TriageActionDraftV1 = Readonly<{
    label: string;
    enabled: boolean;
    appliesTo: readonly TriageSourceWorkflowSubjectV1[];
    profileId: string | null;
    workspaceMode: TriageActionWorkspaceModeV1;
    target: TriageActionTargetV1;
}>;

export type TriageActionCommandV1 =
    | (TriageActionDraftV1 & Readonly<{ kind: 'create' }>)
    | (TriageActionDraftV1 & Readonly<{ kind: 'update'; actionId: string }>)
    | Readonly<{ kind: 'delete'; actionId: string }>
    /** An exact permutation of the stored set; nothing is added or dropped here. */
    | Readonly<{ kind: 'reorder'; actionIds: readonly string[] }>;

export type TriageActionsDepsV1 = Readonly<{
    settings: Pick<ScopedSettingsService, 'snapshot' | 'set'>;
    /** The opaque action id is minted only here, and only for a create. */
    mintActionId: () => string;
    signal?: AbortSignal;
}>;

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

function readBoundedString(value: unknown, maxUtf8Bytes: number): string | null {
    if (typeof value !== 'string') return null;
    // The canonical single-line rule, so a label cannot carry a control
    // character that costs one byte here and six once JSON escapes it.
    const normalized = normalizeTriageSingleLineV1(value);
    if (normalized.length === 0) return null;
    return utf8ByteLength(normalized) > maxUtf8Bytes ? null : normalized;
}

function readClosedValue<TValue extends string>(
    admitted: readonly TValue[],
): (value: unknown) => TValue | null {
    return (value) => (typeof value === 'string' && (admitted as readonly string[]).includes(value)
        ? value as TValue
        : null);
}

const readWorkspaceMode = readClosedValue(TRIAGE_WORKSPACE_MODES_V1);
const readDelivery = readClosedValue(TRIAGE_ACTION_DELIVERIES_V1);
const readSubject = readClosedValue(ALL_SUBJECTS);

type Outcome<TValue> =
    | Readonly<{ ok: true; value: TValue }>
    | Readonly<{ ok: false; reason: TriageActionsRejectionV1 }>;

function readAppliesTo(raw: unknown): Outcome<readonly TriageSourceWorkflowSubjectV1[]> {
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'appliesTo' };
    const subjects: TriageSourceWorkflowSubjectV1[] = [];
    for (const member of raw) {
        const subject = readSubject(member);
        if (subject === null) return { ok: false, reason: 'appliesTo' };
        // Deduplicating silently would make one press decide which of two
        // identical rows the reader thought they were editing.
        if (subjects.includes(subject)) return { ok: false, reason: 'duplicateSubject' };
        subjects.push(subject);
    }
    return { ok: true, value: subjects };
}

function readTarget(raw: unknown): Outcome<TriageActionTargetV1> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, reason: 'target' };
    }
    const kind = (raw as Readonly<Record<string, unknown>>).kind;
    if (kind === 'reviewStart') {
        return readExactKeys(raw, ['kind']) === null
            ? { ok: false, reason: 'target' }
            : { ok: true, value: { kind: 'reviewStart' } };
    }
    if (kind !== 'agent') return { ok: false, reason: 'target' };
    const candidate = readExactKeys(raw, ['kind', 'promptInvocationToken', 'delivery']);
    if (candidate === null) return { ok: false, reason: 'target' };

    // The token is stored as the Prompt Library's own handle and is deliberately
    // NOT re-validated against that Library's grammar here: restating it would
    // be a second spelling of one rule, and a token naming no invocation is a
    // resolution failure the start reports, not a stored-value failure.
    const promptInvocationToken = candidate.promptInvocationToken === null
        ? null
        : readBoundedString(candidate.promptInvocationToken, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
    if (promptInvocationToken === null && candidate.promptInvocationToken !== null) {
        return { ok: false, reason: 'promptInvocationToken' };
    }
    const delivery = readDelivery(candidate.delivery);
    if (delivery === null) return { ok: false, reason: 'delivery' };
    return { ok: true, value: { kind: 'agent', promptInvocationToken, delivery } };
}

/**
 * Validate one action. The same rules run for a stored value and for an incoming
 * draft, so an action that could not be written cannot be read back either.
 */
function readAction(actionId: string, draft: Readonly<{
    label: unknown;
    enabled: unknown;
    appliesTo: unknown;
    profileId: unknown;
    workspaceMode: unknown;
    target: unknown;
}>): Outcome<TriageActionV1> {
    const label = readBoundedString(draft.label, MAX_TRIAGE_ACTION_LABEL_UTF8_BYTES_V1);
    if (label === null) return { ok: false, reason: 'label' };
    if (typeof draft.enabled !== 'boolean') return { ok: false, reason: 'enabled' };
    const appliesTo = readAppliesTo(draft.appliesTo);
    if (!appliesTo.ok) return appliesTo;
    const profileId = draft.profileId === null
        ? null
        : readBoundedString(draft.profileId, MAX_TRIAGE_ACTION_PROFILE_ID_LENGTH_V1);
    if (profileId === null && draft.profileId !== null) return { ok: false, reason: 'profileId' };
    const workspaceMode = readWorkspaceMode(draft.workspaceMode);
    if (workspaceMode === null) return { ok: false, reason: 'workspaceMode' };
    const target = readTarget(draft.target);
    if (!target.ok) return target;
    return {
        ok: true,
        value: {
            actionId,
            label,
            enabled: draft.enabled,
            appliesTo: appliesTo.value,
            profileId,
            workspaceMode,
            target: target.value,
        },
    };
}

/**
 * Parse one stored value.
 *
 * Any member this build cannot understand makes the whole value `unreadable`
 * rather than dropping that action: silently discarding one would leave a person
 * pressing a control that no longer exists on their other device, with no
 * upstream owner to recover it from.
 */
export function parseTriageActions(raw: unknown): TriageActionsReadV1 {
    if (raw === undefined || raw === null) return { kind: 'absent', value: TRIAGE_SEEDED_ACTIONS_V1 };
    // A value this build declines to read must not be replaced by the seed
    // either: the seed is what ABSENT means, and offering it for an unreadable
    // value is exactly how a newer client's catalogue gets overwritten.
    const unreadable: TriageActionsReadV1 = { kind: 'unreadable', value: { v: 1, actions: [] } };
    if (typeof raw !== 'object') return unreadable;
    // The whole-value byte bound is read back as well as written: a reader that
    // accepted what its own writer refuses would let a stored value this build
    // never produced push an Action result past the host's own result gate.
    if (utf8ByteLength(JSON.stringify(raw)) > MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1) {
        return unreadable;
    }
    const candidate = readExactKeys(raw, ['v', 'actions']);
    if (!candidate || candidate.v !== 1 || !Array.isArray(candidate.actions)) return unreadable;
    if (candidate.actions.length > MAX_TRIAGE_ACTIONS_V1) return unreadable;

    const actions: TriageActionV1[] = [];
    const ids = new Set<string>();
    for (const member of candidate.actions) {
        const stored = readExactKeys(member, [
            'actionId',
            'label',
            'enabled',
            'appliesTo',
            'profileId',
            'workspaceMode',
            'target',
        ]);
        if (!stored) return unreadable;
        const actionId = readBoundedString(stored.actionId, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
        // Two rows claiming one id would make every later edit ambiguous.
        if (actionId === null || ids.has(actionId)) return unreadable;
        ids.add(actionId);
        const parsed = readAction(actionId, {
            label: stored.label,
            enabled: stored.enabled,
            appliesTo: stored.appliesTo,
            profileId: stored.profileId,
            workspaceMode: stored.workspaceMode,
            target: stored.target,
        });
        if (!parsed.ok) return unreadable;
        actions.push(parsed.value);
    }
    return { kind: 'parsed', value: { v: 1, actions } };
}

/**
 * Project the validated value to the exact JSON that is stored.
 *
 * The value is rebuilt member by member rather than passed through, so nothing
 * the validator did not admit can ride into durable Account state.
 */
function toStoredValue(value: TriageActionsSettingV1): JsonValue {
    return {
        v: 1,
        actions: value.actions.map((action): JsonValue => ({
            actionId: action.actionId,
            label: action.label,
            enabled: action.enabled,
            appliesTo: [...action.appliesTo],
            profileId: action.profileId,
            workspaceMode: action.workspaceMode,
            target: action.target.kind === 'reviewStart'
                ? { kind: 'reviewStart' }
                : {
                    kind: 'agent',
                    promptInvocationToken: action.target.promptInvocationToken,
                    delivery: action.target.delivery,
                },
        })),
    };
}

export async function readTriageActions(deps: Readonly<{
    settings: Pick<ScopedSettingsService, 'snapshot'>;
    signal?: AbortSignal;
}>): Promise<TriageActionsReadV1 & Readonly<{ revision: string }>> {
    const snapshot = await deps.settings.snapshot(deps.signal ? { signal: deps.signal } : undefined);
    const read = parseTriageActions(snapshot.values[TRIAGE_ACTIONS_SETTING_ID_V1]);
    return { ...read, revision: snapshot.revision };
}

function applyCommand(
    current: TriageActionsSettingV1,
    command: TriageActionCommandV1,
    mintActionId: () => string,
): TriageActionsMutationResultV1 {
    if (command.kind === 'delete') {
        if (!current.actions.some((action) => action.actionId === command.actionId)) {
            return { status: 'unknownAction' };
        }
        return {
            status: 'applied',
            actionId: command.actionId,
            value: {
                v: 1,
                actions: current.actions.filter((action) => action.actionId !== command.actionId),
            },
        };
    }

    if (command.kind === 'reorder') {
        // An exact permutation, or nothing. A shorter list would delete actions
        // under the guise of reordering, and a repeated id would duplicate one.

        const byId = new Map(current.actions.map((action) => [action.actionId, action]));
        const actions: TriageActionV1[] = [];
        const seen = new Set<string>();
        for (const actionId of command.actionIds) {
            const action = byId.get(actionId);
            if (action === undefined || seen.has(actionId)) {
                return { status: 'rejected', reason: 'reorder' };
            }
            seen.add(actionId);
            actions.push(action);
        }
        return { status: 'applied', actionId: null, value: { v: 1, actions } };
    }

    if (command.kind === 'update') {
        const index = current.actions.findIndex((action) => action.actionId === command.actionId);
        if (index < 0) return { status: 'unknownAction' };
        const parsed = readAction(command.actionId, command);
        if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
        const actions = [...current.actions];
        actions[index] = parsed.value;
        return { status: 'applied', actionId: command.actionId, value: { v: 1, actions } };
    }

    if (current.actions.length >= MAX_TRIAGE_ACTIONS_V1) {
        return { status: 'rejected', reason: 'actionLimit' };
    }
    const actionId = mintActionId();
    const parsed = readAction(actionId, command);
    if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
    if (current.actions.some((action) => action.actionId === actionId)) {
        return { status: 'rejected', reason: 'actionId' };
    }
    return {
        status: 'applied',
        actionId,
        value: { v: 1, actions: [...current.actions, parsed.value] },
    };
}

/**
 * The one typed create/update/delete/reorder write.
 *
 * It reads the authoritative record, validates the whole resulting value, and
 * writes it against the revision it read. A losing write returns the typed
 * `conflict` and the caller re-reads: there is no last-writer-wins merge and no
 * hidden local copy.
 *
 * An absent record is edited as the SEED rather than as an empty set, so the
 * first action a person adds does not silently delete Ask, Fix and Review. The
 * seed becomes stored bytes on that first write, which is also the moment the
 * user first expressed an opinion about it.
 *
 * `conflict` means exactly one thing — the host refused this write because
 * another writer moved the revision. Every other refusal the Settings service
 * raises, and an abort or a store failure, surfaces as itself.
 */
export async function mutateTriageAction(
    deps: TriageActionsDepsV1,
    command: TriageActionCommandV1,
): Promise<TriageActionsMutationResultV1> {
    const options = deps.signal ? { signal: deps.signal } : undefined;
    const snapshot = await deps.settings.snapshot(options);
    const read = parseTriageActions(snapshot.values[TRIAGE_ACTIONS_SETTING_ID_V1]);
    // Refusing here is what keeps a newer client's catalogue alive: this build
    // cannot merge into a value it cannot read, so it declines rather than
    // replacing it with its own idea of the set.
    if (read.kind === 'unreadable') return { status: 'unreadable' };

    const applied = applyCommand(read.value, command, deps.mintActionId);
    if (applied.status !== 'applied') return applied;

    const stored = toStoredValue(applied.value);
    if (utf8ByteLength(JSON.stringify(stored)) > MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1) {
        return { status: 'rejected', reason: 'valueTooLarge' };
    }

    try {
        await deps.settings.set(TRIAGE_ACTIONS_SETTING_ID_V1, stored, {
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
