import { isPluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_ACCOUNT_STORAGE_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1,
    TriageSourceWorkflowSubjectV1Schema,
    normalizeTriageSingleLineV1,
    type TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import {
    TRIAGE_WORKSPACE_MODES_V1,
    type TriageWorkspaceModeV1,
} from '../sessions/entrySessionWorkspace.js';
import { readExactKeys } from './storedValue.js';
import type { TriageCatalogStoreV1 } from './accountKvCatalogStore.js';

/**
 * The sole `triage.actions` owner: the configurable set of things a reader can
 * start from an entry, read, validated and written in one place.
 *
 * An action is a **composition record**, not a workflow. It answers five
 * questions and delegates everything else to an owner that already exists:
 *
 *  - `appliesTo` — which subjects it is offered on;
 *  - `profileId` — which Launch Profile supplies the Session defaults;
 *  - `promptInvocationId` — which Prompt Library invocation supplies the task
 *    instruction, by its STABLE id;
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

/** The one versioned Account KV key this document owns. */
export const TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 = 'triage.actions';

/**
 * `LaunchProfileV2.id` is bounded at 256 characters
 * (`packages/protocol/src/profiles/v2/schema.ts`); a profile id this record
 * would accept but the profile owner would refuse could never resolve.
 */
export const MAX_TRIAGE_ACTION_PROFILE_ID_LENGTH_V1 = 256;
/**
 * The whole serialized `triage.actions` value, measured over the complete value
 * rather than per member, because a set of individually valid actions is exactly
 * how an Account KV value overflows. Account Data owns this boundary; Triage
 * aliases it instead of maintaining a second 64-KiB ledger.
 */
export const MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 =
    PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes;

/**
 * The Account KV adapter transports either the literal `absent` or the decimal
 * spelling of the owner's non-negative safe-integer version. This wire bound is
 * therefore derived from that real host boundary rather than inherited from
 * the unrelated Account Settings revision grammar.
 */
export const MAX_TRIAGE_ACCOUNT_KV_REVISION_TOKEN_LENGTH_V1 = String(Number.MAX_SAFE_INTEGER).length;

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
 * `promptInvocationId` is `PromptInvocationEntryV1.id`
 * (`packages/protocol/src/prompts/library/promptInvocationsV1.ts`) — the
 * Library's own STABLE identity, deliberately not its `token`. The token is the
 * slash name a person types and may rename at will; storing it here would mean
 * renaming `/explain` to `/discuss` silently breaks every configured action
 * that referenced it, with no upstream owner to recover the reference from.
 *
 * It is stored as a reference, never as a copied body: Triage holds no prompt
 * text, so editing the prompt in the Library changes what every action using it
 * sends.
 *
 * **The Library owns WHICH content resolves; the action owns WHETHER it is
 * composed or sent.** `PromptInvocationEntryV1.behavior`
 * (`insert | insert_on_send | insert_and_send`) is the composer-command
 * affordance for somebody typing that slash token, and it does NOT override
 * `delivery`: a person who configured an action to send did not also ask the
 * Library to decide that for them.
 *
 * `delivery` is meaningful with or without a prompt. With one it says whether
 * the body is composed or sent; without one it says whether the Session opens
 * with the entry attached and waiting, or sends that attachment straight away.
 */
export type TriageActionTargetV1 =
    | Readonly<{
        kind: 'agent';
        promptInvocationId: string | null;
        delivery: TriageActionDeliveryV1;
    }>
    /**
     * The incumbent `review.start` contract owns its engines and its scope.
     *
     * It carries a prompt reference and no `delivery`, because `review.start`
     * has exactly one delivery — it starts runs — but its `instructions` are a
     * required, user-authored field. Answering that from the same Prompt
     * Library reference the agent arm uses is what keeps ONE place a person
     * configures what they want looked at; leaving it unanswerable would have
     * made this arm depend on prose Triage invented.
     */
    | Readonly<{ kind: 'reviewStart'; promptInvocationId: string | null }>;

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

export type TriageActionsCatalogV1 = Readonly<{
    v: 1;
    /** Array order is display order; reordering is a first-class write. */
    actions: readonly TriageActionV1[];
}>;

const ALL_SUBJECTS: readonly TriageSourceWorkflowSubjectV1[] =
    Object.freeze([...TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1]);

/**
 * THE action grammar — one declaration, two projections.
 *
 * An action record is expressed in exactly one place and then PROJECTED to
 * everywhere a boundary needs to state it: the two catalog Actions' wire
 * contracts (`actions/actionsCatalogProtocol.ts`) and the schema-derived size
 * inventory.
 *
 * It exists because the alternative was tried and failed. The declaration used
 * to be a hand-written JSON Schema that spelled the same members a second time,
 * and it drifted: it declared `reviewStart` as a CLOSED object of `{ kind }`
 * alone while this owner's record — and the wire, and the seed shipped in this
 * very file — carry `promptInvocationId` on that arm. Projecting the Action wire
 * grammar from this owner makes that second spelling unrepresentable.
 *
 * It is a grammar, not the authority. The rules a JSON Schema cannot state —
 * single-line normalization, UTF-8 byte bounds measured after trimming, the
 * refusal of a repeated subject, the whole-value ceiling and the CAS decision —
 * stay with the reader and writer below, which are strictly stricter than this
 * shape. Every member here is a reference or a closed vocabulary, so there is
 * nowhere on either boundary to express a condition, a step, a
 * retry, a variable, a branch or a hook.
 */

const triageActionIdSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const triageActionLabelSchema = defineProtocolString({
    minLength: 1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const triageActionProfileIdSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_ACTION_PROFILE_ID_LENGTH_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/**
 * The Prompt Library's own STABLE invocation id, carried as a reference.
 *
 * It is `PromptInvocationEntryV1.id`, never the renameable `token`: a slash
 * command a person renames must not silently break every action configured
 * against it. Triage stores no prompt body and no boundary here carries one —
 * editing the invocation in the Library changes what every action naming it
 * sends — and an id that names no invocation is a resolution failure the press
 * reports, not a stored-value failure a schema could have caught.
 */
const triagePromptInvocationIdSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

const triageNullablePromptInvocationIdSchema = defineProtocolUnion([
    triagePromptInvocationIdSchema,
    defineProtocolLiteral(null),
]);

export const TriageActionWorkspaceModeV1Schema = defineProtocolUnion([
    defineProtocolLiteral('reference_only'),
    defineProtocolLiteral('repository'),
    defineProtocolLiteral('pull_request'),
]);

export const TriageActionDeliveryV1Schema = defineProtocolUnion([
    defineProtocolLiteral('compose'),
    defineProtocolLiteral('send'),
]);

/**
 * The arm is a member, so nothing on any boundary infers it from a label.
 *
 * An `agent` action starts a Session and hands the agent a resolved prompt; a
 * `reviewStart` action targets the incumbent `review.start` contract, which
 * owns its own engines and scope — but not its `instructions`, which are a
 * required user-authored field, so it carries the same Prompt Library reference
 * and no `delivery` (starting runs is the only delivery it has).
 */
export const TriageActionTargetV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('agent'),
        promptInvocationId: triageNullablePromptInvocationIdSchema,
        delivery: TriageActionDeliveryV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('reviewStart'),
        promptInvocationId: triageNullablePromptInvocationIdSchema,
    }, { policy: 'closed' }),
]);

export const TriageActionAppliesToV1Schema = defineProtocolArray(
    TriageSourceWorkflowSubjectV1Schema,
    {
        // One entry per subject at most: the record refuses a repeated subject
        // rather than deduplicating it, so a wider array could only ever be
        // rejected downstream.
        maxItems: TRIAGE_SOURCE_WORKFLOW_SUBJECTS_V1.length,
    },
);

/** Everything an action is, minus the identity the writer owns. */
export const TRIAGE_ACTION_DRAFT_MEMBERS_V1 = {
    label: triageActionLabelSchema,
    enabled: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
    appliesTo: TriageActionAppliesToV1Schema,
    profileId: defineProtocolUnion([triageActionProfileIdSchema, defineProtocolLiteral(null)]),
    workspaceMode: TriageActionWorkspaceModeV1Schema,
    target: TriageActionTargetV1Schema,
} as const;

export const TriageActionIdV1Schema = triageActionIdSchema;

/** The Account KV version token, carried across the Action wire as decimal text. */
export const TriageAccountKvRevisionV1Schema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_ACCOUNT_KV_REVISION_TOKEN_LENGTH_V1,
});

export const TriageActionRecordV1Schema = defineProtocolObject({
    actionId: triageActionIdSchema,
    ...TRIAGE_ACTION_DRAFT_MEMBERS_V1,
}, { policy: 'closed' });

export const TriageActionRecordsV1Schema = defineProtocolArray(TriageActionRecordV1Schema);

/** The stored `triage.actions` value, exactly as `toStoredValue` emits it. */
export const TriageActionsCatalogValueV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    actions: TriageActionRecordsV1Schema,
}, { policy: 'closed' });

/**
 * The shipped seed.
 *
 * Three actions whose complete start paths are reachable in current bytes:
 *
 *  - **Ask** — read the entry, change nothing, every subject.
 *  - **Fix** — repair it in the project the reader selected, every subject.
 *  - **Review** — an ordinary AGENT action on a pull request: it starts a
 *    Session with the reader's own profile and prompt and asks that agent to
 *    review the change. This is the arm that works today.
 *
 * `reviewStart` remains configurable rather than seeded: Ask, Fix and the
 * ordinary agent Review are the shipped defaults, while a reader who wants the
 * formal engine-selection flow can add or retarget an action explicitly.
 */
export const TRIAGE_DEFAULT_ACTIONS_V1: readonly TriageActionV1[] = Object.freeze([
    Object.freeze({
        actionId: 'ask',
        label: 'Ask',
        enabled: true,
        appliesTo: ALL_SUBJECTS,
        profileId: null,
        workspaceMode: 'reference_only',
        target: Object.freeze({ kind: 'agent', promptInvocationId: null, delivery: 'compose' }),
    }),
    Object.freeze({
        actionId: 'fix',
        label: 'Fix',
        enabled: true,
        appliesTo: ALL_SUBJECTS,
        profileId: null,
        workspaceMode: 'repository',
        target: Object.freeze({ kind: 'agent', promptInvocationId: null, delivery: 'compose' }),
    }),
    Object.freeze({
        actionId: 'review',
        label: 'Review',
        enabled: true,
        appliesTo: Object.freeze(['pullRequest'] as const),
        profileId: null,
        // A pull request an agent reviews still runs in the reader's selected
        // project: reviewing a change does not require the source-prepared
        // worktree that `review.start` needs to describe exact commits.
        workspaceMode: 'repository',
        target: Object.freeze({ kind: 'agent', promptInvocationId: null, delivery: 'compose' }),
    }),
] as readonly TriageActionV1[]);

/**
 * The one current target-availability decision.
 *
 * Both declared target arms have mounted producers. Keeping this decision at
 * the catalog owner means the editor and every mounted action surface expose
 * the same current set rather than independently guessing availability.
 */
export function isTriageActionTargetOfferableV1(
    kind: TriageActionTargetV1['kind'],
): boolean {
    return kind === 'agent' || kind === 'reviewStart';
}

/** The one valid target/materialization/subject rule shared by storage and mounts. */
export function isTriageActionConfigurationCoherentV1(
    action: Pick<TriageActionV1, 'target' | 'workspaceMode' | 'appliesTo'>,
): boolean {
    return action.target.kind === 'agent'
        || (action.workspaceMode === 'pull_request'
            && action.appliesTo.length === 1
            && action.appliesTo[0] === 'pullRequest');
}

/** The catalog projection shared by surfaces that do not know one subject. */
export function planTriageOfferableActionsV1(
    actions: readonly TriageActionV1[],
): readonly TriageActionV1[] {
    return actions.filter(
        (action) => action.enabled
            && isTriageActionTargetOfferableV1(action.target.kind)
            && isTriageActionConfigurationCoherentV1(action),
    );
}

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
    return planTriageOfferableActionsV1(actions).filter(
        (action) => action.appliesTo.includes(workflowSubject),
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
    'code-review': 'plugins.triage.surface.session.codeReview',
});

export function readTriageActionTitleKeyV1(action: TriageActionV1): string | null {
    const seeded = TRIAGE_DEFAULT_ACTIONS_V1.find(
        (candidate) => candidate.actionId === action.actionId,
    );
    if (seeded === undefined || seeded.label !== action.label) return null;
    return SEEDED_ACTION_TITLE_KEYS_V1[action.actionId] ?? null;
}

/** The parsed absence: the seed, which needs no write to exist. */
export const TRIAGE_SEEDED_ACTIONS_V1: TriageActionsCatalogV1 = Object.freeze({
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
    value: TriageActionsCatalogV1;
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
    | 'promptInvocationId'
    | 'delivery'
    | 'reorder'
    | 'valueTooLarge';

export type TriageActionsMutationResultV1 =
    | Readonly<{
        status: 'applied';
        actionId: string | null;
        value: TriageActionsCatalogV1;
        /**
         * The revision the applied value now sits at, so the caller can make a
         * second edit without a round trip — and, more importantly, cannot make
         * one against the revision it already spent.
         */
        revision: string;
    }>
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

/**
 * The revision the CALLER read the catalog at, required on every write.
 *
 * Re-reading immediately before the write and CASing against that fresh
 * revision — which is what this owner used to do — only makes the final `set`
 * atomic. It cannot notice a change made while somebody had the editor open,
 * because the value it compares was read AFTER that change landed. A person who
 * opened the editor, went away, came back and pressed Save would silently
 * overwrite whatever their other device stored in between, and the write would
 * report `applied`.
 *
 * So the revision travels with the intent: the caller states which catalog it
 * was looking at, and a write against a catalog that has moved is the same
 * `conflict` a losing race already produced. One value, compared once, with no
 * merge and no queue — the loser re-reads and decides again with the truth in
 * front of them.
 */
type TriageActionCommandBaseV1 = Readonly<{ expectedRevision: string }>;

export type TriageActionCommandV1 = TriageActionCommandBaseV1 & (
    | (TriageActionDraftV1 & Readonly<{ kind: 'create' }>)
    | (TriageActionDraftV1 & Readonly<{ kind: 'update'; actionId: string }>)
    | Readonly<{ kind: 'delete'; actionId: string }>
    /** An exact permutation of the stored set; nothing is added or dropped here. */
    | Readonly<{ kind: 'reorder'; actionIds: readonly string[] }>
);

export type TriageActionsDepsV1 = Readonly<{
    catalog: TriageCatalogStoreV1;
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

function readSingleLineString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = normalizeTriageSingleLineV1(value);
    return normalized.length === 0 ? null : normalized;
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

/**
 * The stored Prompt Library reference, read once for both target arms.
 *
 * It is the Library's own STABLE id and is deliberately NOT re-validated
 * against that Library's contents here: an id naming no invocation is a
 * resolution failure the press reports with the person's own configuration in
 * front of them, not a stored-value failure that makes the whole catalogue
 * unreadable the moment somebody deletes one prompt.
 */
function readPromptInvocationId(raw: unknown): Outcome<string | null> {
    if (raw === null) return { ok: true, value: null };
    const value = readBoundedString(raw, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
    return value === null
        ? { ok: false, reason: 'promptInvocationId' }
        : { ok: true, value };
}

function readTarget(raw: unknown): Outcome<TriageActionTargetV1> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, reason: 'target' };
    }
    const kind = (raw as Readonly<Record<string, unknown>>).kind;
    if (kind === 'reviewStart') {
        const reviewCandidate = readExactKeys(raw, ['kind', 'promptInvocationId']);
        if (reviewCandidate === null) return { ok: false, reason: 'target' };
        const reviewPrompt = readPromptInvocationId(reviewCandidate.promptInvocationId);
        if (!reviewPrompt.ok) return reviewPrompt;
        return { ok: true, value: { kind: 'reviewStart', promptInvocationId: reviewPrompt.value } };
    }
    if (kind !== 'agent') return { ok: false, reason: 'target' };
    const candidate = readExactKeys(raw, ['kind', 'promptInvocationId', 'delivery']);
    if (candidate === null) return { ok: false, reason: 'target' };

    const prompt = readPromptInvocationId(candidate.promptInvocationId);
    if (!prompt.ok) return prompt;
    const promptInvocationId = prompt.value;
    const delivery = readDelivery(candidate.delivery);
    if (delivery === null) return { ok: false, reason: 'delivery' };
    return { ok: true, value: { kind: 'agent', promptInvocationId, delivery } };
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
    // The enclosing Account KV value owns the real byte boundary. A
    // second per-label ceiling would reject otherwise valid user configuration.
    const label = readSingleLineString(draft.label);
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
    if (!isTriageActionConfigurationCoherentV1({
        workspaceMode,
        target: target.value,
        appliesTo: appliesTo.value,
    })) {
        return { ok: false, reason: 'workspaceMode' };
    }
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
    // The local whole-value bound is read back as well as written so the reader
    // and writer agree about which Account KV values this implementation owns.
    if (utf8ByteLength(JSON.stringify(raw)) > MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1) {
        return unreadable;
    }
    const candidate = readExactKeys(raw, ['v', 'actions']);
    if (!candidate || candidate.v !== 1 || !Array.isArray(candidate.actions)) return unreadable;

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
function toStoredValue(value: TriageActionsCatalogV1): JsonValue {
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
                ? { kind: 'reviewStart', promptInvocationId: action.target.promptInvocationId }
                : {
                    kind: 'agent',
                    promptInvocationId: action.target.promptInvocationId,
                    delivery: action.target.delivery,
                },
        })),
    };
}

export async function readTriageActions(deps: Readonly<{
    catalog: Pick<TriageCatalogStoreV1, 'read'>;
    signal?: AbortSignal;
}>): Promise<TriageActionsReadV1 & Readonly<{ revision: string }>> {
    const snapshot = await deps.catalog.read(deps.signal ? { signal: deps.signal } : undefined);
    const read = parseTriageActions(snapshot.value);
    return { ...read, revision: snapshot.revision };
}

/** The verdict before the write: identical to the public one, minus the revision only a settled write can state. */
type TriageActionsAppliedPlanV1 =
    | Readonly<{ status: 'applied'; actionId: string | null; value: TriageActionsCatalogV1 }>
    | Exclude<TriageActionsMutationResultV1, Readonly<{ status: 'applied' }>>;

function applyCommand(
    current: TriageActionsCatalogV1,
    command: TriageActionCommandV1,
    mintActionId: () => string,
): TriageActionsAppliedPlanV1 {
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
        //
        // The length is checked because nothing below can: every member of a
        // shorter list is a known, unique, stored id, so a loop that only
        // validates members accepts the deletion whole. That is the shape the
        // comment above already claimed and the code did not have.
        if (command.actionIds.length !== current.actions.length) {
            return { status: 'rejected', reason: 'reorder' };
        }

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
 * It reads the authoritative record, refuses a command aimed at a revision the
 * caller no longer holds, validates the whole resulting value, and writes it
 * against that same revision. A losing write returns the typed `conflict` and
 * the caller re-reads: there is no last-writer-wins merge and no hidden local
 * copy.
 *
 * An absent record is edited as the SEED rather than as an empty set, so the
 * first action a person adds does not silently delete Ask, Fix and Review. The
 * seed becomes stored bytes on that first write, which is also the moment the
 * user first expressed an opinion about it.
 *
 * `conflict` means exactly one thing — the host refused this write because
 * another writer moved the revision. Every other refusal the Account KV service
 * raises, and an abort or a store failure, surfaces as itself.
 */
export async function mutateTriageAction(
    deps: TriageActionsDepsV1,
    command: TriageActionCommandV1,
): Promise<TriageActionsMutationResultV1> {
    const options = deps.signal ? { signal: deps.signal } : undefined;
    const snapshot = await deps.catalog.read(options);
    // The caller's own revision, compared BEFORE anything is computed. A write
    // aimed at a catalogue that has since moved is refused whether or not the
    // final `set` would have raced: the person is looking at a set that no
    // longer exists, and applying their intent to a different one is the
    // silent overwrite this comparison exists to prevent.
    if (snapshot.revision !== command.expectedRevision) return { status: 'conflict' };
    const read = parseTriageActions(snapshot.value);
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

    let mutation: Readonly<{ revision: string }>;
    try {
        // The same revision goes to the host, so a writer that lands between
        // this read and this write still loses. The caller comparison above
        // covers the window the host cannot see; this covers the one it can.
        mutation = await deps.catalog.write(stored, {
            expectedRevision: snapshot.revision,
            ...(deps.signal ? { signal: deps.signal } : {}),
        });
    } catch (error) {
        if (isPluginError(error) && error.code === 'plugin_account_kv_conflict') {
            return { status: 'conflict' };
        }
        throw error;
    }
    return { ...applied, revision: mutation.revision };
}
