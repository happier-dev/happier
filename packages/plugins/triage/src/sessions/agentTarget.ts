import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';

/**
 * The Agent a pressed action's Launch Profile prefers, resolved to the exact
 * target the start wire carries.
 *
 * A `LaunchProfileV2` stores `preferredAgentTargetKey`
 * (`packages/protocol/src/profiles/v2/schema.ts`), and a Triage start declares
 * `agentTarget.identity` — `{ pluginId, localId }`. Those are two spellings of
 * one selection, and turning the first into the second is the AGENT INVENTORY's
 * job, never Triage's: the key is the host's backend-target grammar, and a
 * plugin that parsed it would be reconstructing a catalog it does not own.
 *
 * So this module parses nothing. It asks `agents.backends.list` — the same
 * inventory the New Session surface offers the reader — for the rows it already
 * resolved, finds the one whose `targetKey` is EXACTLY the profile's stored key,
 * and takes the `identity` that row published. If no row answers to that key,
 * or the row that does carries no identity, or nothing answered at all, the
 * press degrades to the host's New Session surface and the reader picks the
 * Agent there. That degradation is the whole safety of the one-click path: it
 * never fabricates a target, and it never refuses the reader a Session.
 */

/** The one host Action this module invokes. */
export const TRIAGE_AGENTS_BACKENDS_LIST_ACTION_ID_V1 = 'agents.backends.list';

export type TriageAgentInventoryHostV1 = Readonly<{
    executeAction(
        action: string,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<unknown>;
}>;

/**
 * The exact shape the start wire admits
 * (`actions/entrySessionProtocol.ts#TriageAgentExecutionTargetV1Schema`), built
 * only from what the inventory resolved.
 */
export type TriageAgentExecutionTargetV1 = Readonly<{
    kind: 'agent';
    identity: Readonly<{ pluginId: string; localId: string }>;
}>;

export type TriageAgentExecutionTargetReadV1 =
    | Readonly<{ status: 'resolved'; agentTarget: TriageAgentExecutionTargetV1 }>
    /**
     * The catalogue answered and nothing in it can be started under that key —
     * it is gone, it is disabled, or it is a configured backend selectable only
     * by `backendId`, which this wire does not carry.
     */
    | Readonly<{ status: 'unresolved' }>
    /** Nothing answered. Deliberately distinct from "there is no such Agent". */
    | Readonly<{ status: 'unavailable' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

export async function readTriageAgentExecutionTargetV1(
    host: TriageAgentInventoryHostV1,
    preferredAgentTargetKey: string,
    options?: PluginCancellationOptions,
): Promise<TriageAgentExecutionTargetReadV1> {
    let result: unknown;
    try {
        result = await host.executeAction(TRIAGE_AGENTS_BACKENDS_LIST_ACTION_ID_V1, {}, options);
    } catch {
        return { status: 'unavailable' };
    }
    if (!isRecord(result) || !Array.isArray(result.items)) return { status: 'unavailable' };

    const wanted = preferredAgentTargetKey.trim();
    for (const item of result.items) {
        if (!isRecord(item)) continue;
        // Exactly the stored key. A prefix, a label or an `agentId` near-miss
        // resolves a DIFFERENT Agent, which is worse than resolving none.
        if (readNonEmptyString(item.targetKey) !== wanted) continue;
        // A disabled backend is not a place to start a Session unattended.
        if (item.enabled !== true) return { status: 'unresolved' };
        const identity = item.identity;
        if (!isRecord(identity)) return { status: 'unresolved' };
        const pluginId = readNonEmptyString(identity.pluginId);
        const localId = readNonEmptyString(identity.localId);
        if (pluginId === null || localId === null) return { status: 'unresolved' };
        return {
            status: 'resolved',
            agentTarget: Object.freeze({
                kind: 'agent',
                identity: Object.freeze({ pluginId, localId }),
            }),
        };
    }
    return { status: 'unresolved' };
}
