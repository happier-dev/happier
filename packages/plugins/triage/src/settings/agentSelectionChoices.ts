import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import type { TriageAgentSelectionV1 } from './agentSelection.js';

/**
 * What a Triage agent selection may hold, and what a stored one means to the
 * generic Session creator.
 *
 * Triage keeps no agent list of its own. The agents a person may choose are
 * whatever the host's `agents.backends.list` inventory reports right now — the
 * same inventory behind the `agents.backends.enabled` option source that
 * `session.spawn_new`'s own `agentTarget` field uses. Nothing here is cached,
 * persisted or ranked: this is a pass-through read, not a second catalog.
 *
 * The two spawn members are the exact canonical types the Session creator
 * accepts, projected from the generated Action map rather than restated, so a
 * stored selection and the start it feeds cannot disagree about shape.
 */

export type TriageSpawnAgentTargetV1 = NonNullable<
    PluginActionInputById['session.spawn_new']['agentTarget']
>;
export type TriageSpawnModelSelectionV1 = NonNullable<
    PluginActionInputById['session.spawn_new']['modelSelection']
>;

export type TriageAgentChoiceV1 = Readonly<{
    /** The host's own key, stored verbatim by `agentSelection.ts`. */
    agentTargetKey: string;
    label: string;
    description: string | null;
    /** Always present: a row that cannot become one is never offered. */
    agentTarget: TriageSpawnAgentTargetV1;
}>;

export type TriageAgentModelOptionV1 = Readonly<{
    modelId: string;
    label: string;
    description: string | null;
}>;

export type TriageAgentModelChoicesV1 = Readonly<{
    models: readonly TriageAgentModelOptionV1[];
    /**
     * The chosen agent accepts a model id it did not enumerate. A surface may
     * then let the reader type one; the stored value bounds it either way.
     */
    supportsFreeform: boolean;
}>;

/** The two host inventory reads this document performs, and no others. */
export type TriageAgentInventoryActionIdV1 = 'agents.backends.list' | 'agents.models.list';

export type TriageAgentInventoryInvokerV1 = <TActionId extends TriageAgentInventoryActionIdV1>(
    actionId: TActionId,
    input: PluginActionInputById[TActionId],
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<PluginActionResultById[TActionId]>;

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 && value === value.trim() ? value : null;
}

function readOptionalDescription(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Project one inventory row, or refuse it.
 *
 * A row is refused for exactly three reasons, and each one would otherwise put
 * a choice in Triage settings that fails at start time: the agent is disabled;
 * the row carries no qualified Agent identity, which every configured ACP
 * backend row does — `session.spawn_new` accepts only
 * `{ kind: 'agent', identity }` (`AgentExecutionTargetV1Schema`), so such a row
 * cannot be a Session target at all; or the row's own key or identity is not a
 * usable identifier.
 */
function readAgentChoice(row: unknown): TriageAgentChoiceV1 | null {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const candidate = row as Readonly<Record<string, unknown>>;
    if (candidate.enabled === false) return null;

    const agentTargetKey = readNonEmptyString(candidate.targetKey);
    const label = readNonEmptyString(candidate.label);
    if (agentTargetKey === null || label === null) return null;

    const identity = candidate.identity;
    if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) return null;
    const pluginId = readNonEmptyString((identity as Readonly<Record<string, unknown>>).pluginId);
    const localId = readNonEmptyString((identity as Readonly<Record<string, unknown>>).localId);
    if (pluginId === null || localId === null) return null;

    return {
        agentTargetKey,
        label,
        description: readOptionalDescription(candidate.description),
        agentTarget: { kind: 'agent', identity: { pluginId, localId } },
    };
}

function readItems(result: unknown): readonly unknown[] {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return [];
    const items = (result as Readonly<Record<string, unknown>>).items;
    return Array.isArray(items) ? items : [];
}

/**
 * The agents a Triage start may be pointed at.
 *
 * Disabled agents are excluded twice over: the request asks the host not to
 * include them, and a row that still reports itself disabled is dropped. The
 * inventory answer is the authority; an answer this build cannot read is
 * reported as no agents rather than thrown, so a settings surface says "no
 * agents to choose" instead of failing to open.
 */
export async function listTriageAgentChoices(input: Readonly<{
    execute: TriageAgentInventoryInvokerV1;
    signal?: AbortSignal;
}>): Promise<readonly TriageAgentChoiceV1[]> {
    const result = await input.execute(
        'agents.backends.list',
        { includeDisabled: false },
        input.signal ? { signal: input.signal } : undefined,
    );
    return readItems(result)
        .map((row) => readAgentChoice(row))
        .filter((choice): choice is TriageAgentChoiceV1 => choice !== null);
}

/** The host's own "use whatever this agent defaults to" token. */
const HOST_DEFAULT_MODEL_ID = 'default';

function readModelOption(row: unknown): TriageAgentModelOptionV1 | null {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const candidate = row as Readonly<Record<string, unknown>>;
    const modelId = readNonEmptyString(candidate.id);
    if (modelId === null || modelId === HOST_DEFAULT_MODEL_ID || /\s/u.test(modelId)) return null;
    return {
        modelId,
        label: readNonEmptyString(candidate.label) ?? modelId,
        description: readOptionalDescription(candidate.description),
    };
}

/**
 * The models the chosen agent reports.
 *
 * The host's `default` sentinel is dropped: this setting already expresses "let
 * the agent choose" by holding no model at all, and storing the sentinel
 * instead would send a `modelSelection` the canonical per-message contract
 * refuses (`SessionMessageModelSelectionV1Schema`) in place of sending none.
 *
 * An agent that reports nothing is a normal answer, not a failure — outside a
 * running Session the host has no probed inventory to offer. A surface shows
 * "the agent's default" and, when the agent accepts one, a typed model id.
 */
export async function listTriageAgentModelChoices(input: Readonly<{
    execute: TriageAgentInventoryInvokerV1;
    agentTargetKey: string;
    signal?: AbortSignal;
}>): Promise<TriageAgentModelChoicesV1> {
    const result = await input.execute(
        'agents.models.list',
        { backendTargetKey: input.agentTargetKey },
        input.signal ? { signal: input.signal } : undefined,
    );
    const models = readItems(result)
        .map((row) => readModelOption(row))
        .filter((option): option is TriageAgentModelOptionV1 => option !== null);
    const supportsFreeform = result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && (result as Readonly<Record<string, unknown>>).supportsFreeform === true;
    return { models, supportsFreeform };
}

export type TriageAgentSpawnResolutionV1 =
    /** This intent has no opinion: the generic new-session flow chooses. */
    | Readonly<{ status: 'unset' }>
    /** The chosen agent is not startable right now, and nothing is substituted. */
    | Readonly<{ status: 'unavailable'; agentTargetKey: string }>
    | Readonly<{
        status: 'resolved';
        agentTarget: TriageSpawnAgentTargetV1;
        modelSelection: TriageSpawnModelSelectionV1 | null;
    }>;

/**
 * What one stored selection means to a Session start, right now.
 *
 * The three answers are deliberately distinct and none of them is a fallback.
 * `unset` is the normal state. `unavailable` is the agent the user chose having
 * been disabled or uninstalled since; answering with some other enumerated
 * agent would run their Fix on a backend they never picked, so the caller is
 * told instead. Only `resolved` carries spawn members, and its model is bound to
 * the same agent key that resolved it — the canonical selection is built from
 * the one stored key, so the ref can never name a different agent than the
 * target beside it.
 */
export function resolveTriageAgentSpawnSelection(input: Readonly<{
    selection: TriageAgentSelectionV1 | null;
    choices: readonly TriageAgentChoiceV1[];
}>): TriageAgentSpawnResolutionV1 {
    const { selection } = input;
    if (selection === null) return { status: 'unset' };

    const choice = input.choices.find((entry) => entry.agentTargetKey === selection.agentTargetKey);
    if (!choice) return { status: 'unavailable', agentTargetKey: selection.agentTargetKey };

    const model = selection.model;
    if (model === null) {
        return { status: 'resolved', agentTarget: choice.agentTarget, modelSelection: null };
    }
    // The canonical ref has two arms — native and connection-bound — and each is
    // built as itself rather than cast into place, so a connection id can never
    // ride into the arm that requires none.
    const ref = model.providerConnectionId === null
        ? { agentTargetKey: selection.agentTargetKey, providerConnectionId: null, modelId: model.modelId }
        : {
            agentTargetKey: selection.agentTargetKey,
            providerConnectionId: model.providerConnectionId,
            modelId: model.modelId,
        };
    return {
        status: 'resolved',
        agentTarget: choice.agentTarget,
        modelSelection: { v: 1, ref, updatedAt: model.updatedAt },
    };
}
