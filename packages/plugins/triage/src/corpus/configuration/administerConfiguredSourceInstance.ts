import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type {
    TriageConfiguredSourceInstanceV1,
    TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../collections/bindCorpusCollections.js';
import type { CorpusCollectionHandleV1 } from '../collections/handles.js';
import {
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
    type CorpusSourceInstanceRetiredReasonV1,
} from '../collections/ids.js';
import { fromCorpusStoredRow, toCorpusStoredValue, type CorpusRowV1 } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';
import { renderSourceQualifiedId } from '../identity/components.js';
import { deriveConfiguredSourceInstanceTag } from '../identity/tags.js';

/**
 * The one canonical `source-instances` lifecycle writer.
 *
 * Nothing else in Triage creates, reconfigures, retires or reactivates a
 * configured source instance: discovery persists nothing, a mounted surface
 * persists nothing, and the aggregate list only reads. That single-writer rule
 * is what makes the durable set the exact record of what the user chose rather
 * than a merge of several opinions about it.
 *
 * Row identity is the exact private match tuple — the admitted source
 * contribution, the exact account binding, and the source-native
 * `localInstanceKey` — derived through the collection's own Account-mode-aware
 * derivation. The stable `sourceInstanceId` is minted *into* that
 * tuple-addressed row, so a create race resolves by one CAS winner and every
 * loser re-reading and adopting the winner's id. There is no claim row, lease,
 * registry or alias.
 *
 * The writer holds no ambient clock, no id generator and no source registry:
 * the caller supplies its already-resolved admitted contribution identity, the
 * purpose that contribution's descriptor declares, our clock, and the minting
 * function. It therefore cannot be tricked into writing for a source it was not
 * told about.
 */

type InstanceCollections = Pick<CorpusCollectionsV1, 'sourceInstances'>;

/** The four source-lifecycle intents, exactly as the public Action declares them. */
export type CorpusSourceInstanceAdministrationV1 =
    | Readonly<{ kind: 'create'; draft: TriageSourceInstanceDraftV1 }>
    | Readonly<{ kind: 'reconfigure'; sourceInstanceId: string; draft: TriageSourceInstanceDraftV1 }>
    | Readonly<{ kind: 'remove'; sourceInstanceId: string }>
    | Readonly<{ kind: 'reactivate'; sourceInstanceId: string; draft: TriageSourceInstanceDraftV1 }>;

/**
 * The closed outcome. It names only the canonical `sourceInstanceId`: no
 * binding, configuration, locator or provider value ever leaves this owner
 * through a result.
 */
export type CorpusSourceInstanceAdministrationResultV1 =
    | Readonly<{
        kind: 'active' | 'reused' | 'reconfigured' | 'reactivated' | 'removed';
        sourceInstanceId: string;
    }>
    | Readonly<{ kind: 'invalidCaller' }>
    | Readonly<{ kind: 'conflict' }>;

export type CorpusAdministerConfiguredSourceInstanceInputV1 = Readonly<{
    collections: InstanceCollections;
    /** The caller's currently admitted V1 source contribution identity. */
    source: PluginContributionIdentity;
    /** The purpose that admitted contribution's descriptor declares. */
    declaredPurpose: string;
    request: CorpusSourceInstanceAdministrationV1;
    /** Our clock, supplied by the caller so this owner holds no ambient time. */
    nowMs: number;
    /** Mints one stable private UUID. Called only when a row is genuinely absent. */
    mintSourceInstanceId: () => string;
    signal?: AbortSignal;
}>;

const INVALID_CALLER: CorpusSourceInstanceAdministrationResultV1 = Object.freeze({ kind: 'invalidCaller' });
const CONFLICT: CorpusSourceInstanceAdministrationResultV1 = Object.freeze({ kind: 'conflict' });

function configuredFrom(
    source: PluginContributionIdentity,
    draft: TriageSourceInstanceDraftV1,
    sourceInstanceId: string,
): TriageConfiguredSourceInstanceV1 {
    return {
        v: 1,
        instance: {
            source: { pluginId: source.pluginId, localId: source.localId },
            sourceInstanceId,
        },
        binding: draft.binding,
        localInstanceKey: draft.localInstanceKey,
        configuration: draft.configuration,
        locator: draft.locator,
    };
}

function activeRow(input: Readonly<{
    instanceTag: string;
    source: PluginContributionIdentity;
    configured: TriageConfiguredSourceInstanceV1;
    configuredAtMs: number;
}>): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: input.instanceTag,
        sourceQualifiedId: renderSourceQualifiedId(input.source),
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: input.configuredAtMs,
        configured: input.configured,
    };
}

/** Retirement replaces the lifecycle and names its reason; it deletes nothing. */
function retiredRow(
    row: CorpusSourceInstanceRowV1,
    reason: CorpusSourceInstanceRetiredReasonV1,
): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: row.instanceTag,
        sourceQualifiedId: row.sourceQualifiedId,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired,
        configuredAtMs: row.configuredAtMs,
        configured: row.configured,
        retiredReason: reason,
    };
}

/**
 * Whether one configured row belongs to the admitted source contribution that
 * is asking about it.
 *
 * It is exported because it is the SAME question the caller-scoped read asks,
 * and two copies of "is this row yours" is exactly how one path ends up letting
 * a source see another source's account binding. The writer owns it because the
 * writer is what makes a row belong to a source in the first place.
 */
export function configuredSourceInstanceIsOwnedBy(
    row: CorpusSourceInstanceRowV1,
    source: PluginContributionIdentity,
): boolean {
    const owner = row.configured.instance.source;
    return owner.pluginId === source.pluginId && owner.localId === source.localId;
}

async function readRow(
    sourceInstances: CorpusCollectionHandleV1,
    instanceTag: string,
    options?: PluginCancellationOptions,
): Promise<CorpusRowV1<CorpusSourceInstanceRowV1> | null> {
    const row = await sourceInstances.get(instanceTag, options);
    return row ? fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row) : null;
}

/**
 * Finds the exact row holding one stable `sourceInstanceId`, across both
 * lifecycles.
 *
 * The lookup walks the declared lifecycle index rather than adding a second
 * index keyed on the id: an index value is plaintext server metadata even on an
 * E2EE Account, and the stable id is deliberately private. It must include
 * retired rows so that an explicit reactivation stays possible at all.
 *
 * A row is addressed by the exact private match tuple, so retirement only
 * accumulates a row when the user reconfigures a connection onto a genuinely
 * different account or source-native key. The Collection's own row quota
 * (`collection_quota_exceeded`) is the storage backstop, and this walk is
 * cursor-paged so it reads whatever the set actually holds rather than one
 * arbitrary page of it.
 */
export async function findConfiguredSourceInstanceRow(
    // Only the paged read; the narrow type is what lets a read-only caller pass
    // a query-only handle without casting one back to the writer's.
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>,
    sourceInstanceId: string,
    options?: PluginCancellationOptions,
): Promise<CorpusRowV1<CorpusSourceInstanceRowV1> | null> {
    let cursor: string | undefined;
    do {
        const page = await sourceInstances.query({
            index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
            order: 'asc',
            ...(cursor === undefined ? {} : { cursor }),
        }, options);
        for (const row of page.rows) {
            const decoded = fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row);
            if (decoded.value.configured.instance.sourceInstanceId === sourceInstanceId) return decoded;
        }
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return null;
}

async function putRow(
    sourceInstances: CorpusCollectionHandleV1,
    row: CorpusSourceInstanceRowV1,
    expectedRevision: number | 'absent',
    options?: PluginCancellationOptions,
): Promise<boolean> {
    const result = await sourceInstances.batch(
        [{ kind: 'put', value: toCorpusStoredValue(row), expectedRevision }],
        options,
    );
    return result.status === 'updated';
}

/**
 * `create` — the only arm that mints a stable ref, and only for a genuinely
 * absent row.
 *
 * A live active row is idempotent reuse: a repeat create never overwrites the
 * routing value the user configured, because changing it is `reconfigure`. A
 * live retired row is a conflict rather than a silent revival: a source the
 * user removed comes back only through the explicit `reactivate` arm.
 */
async function createInstance(
    input: CorpusAdministerConfiguredSourceInstanceInputV1,
    draft: TriageSourceInstanceDraftV1,
    instanceTag: string,
    options?: PluginCancellationOptions,
): Promise<CorpusSourceInstanceAdministrationResultV1> {
    const { sourceInstances } = input.collections;
    const existing = await readRow(sourceInstances, instanceTag, options);
    if (existing) {
        if (!configuredSourceInstanceIsOwnedBy(existing.value, input.source)) return INVALID_CALLER;
        return existing.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
            ? { kind: 'reused', sourceInstanceId: existing.value.configured.instance.sourceInstanceId }
            : CONFLICT;
    }

    const written = await putRow(sourceInstances, activeRow({
        instanceTag,
        source: input.source,
        configured: configuredFrom(input.source, draft, input.mintSourceInstanceId()),
        configuredAtMs: input.nowMs,
    }), 'absent', options);
    if (written) {
        const committed = await readRow(sourceInstances, instanceTag, options);
        return committed
            ? { kind: 'active', sourceInstanceId: committed.value.configured.instance.sourceInstanceId }
            : CONFLICT;
    }

    // Another writer won the same tuple-addressed row. Re-read it and adopt the
    // winner's stable ref; the id this call minted is simply discarded.
    const winner = await readRow(sourceInstances, instanceTag, options);
    if (!winner || !configuredSourceInstanceIsOwnedBy(winner.value, input.source)) return CONFLICT;
    return winner.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
        ? { kind: 'reused', sourceInstanceId: winner.value.configured.instance.sourceInstanceId }
        : CONFLICT;
}

/**
 * `reconfigure` — in place while the tuple is unchanged, and a retire-plus-mint
 * otherwise.
 *
 * A changed tuple is a different source instance by construction, so the former
 * row is retired as `reconfigured` and a new stable ref is minted. Both writes
 * go in one atomic batch: a partially applied reconfiguration would leave two
 * active rows for one user intent.
 */
async function reconfigureInstance(
    input: CorpusAdministerConfiguredSourceInstanceInputV1,
    current: CorpusRowV1<CorpusSourceInstanceRowV1>,
    draft: TriageSourceInstanceDraftV1,
    nextInstanceTag: string,
    options?: PluginCancellationOptions,
): Promise<CorpusSourceInstanceAdministrationResultV1> {
    const { sourceInstances } = input.collections;
    if (current.value.lifecycle !== CORPUS_SOURCE_INSTANCE_LIFECYCLE.active) return CONFLICT;
    const sourceInstanceId = current.value.configured.instance.sourceInstanceId;

    if (nextInstanceTag === current.rowId) {
        const written = await putRow(sourceInstances, activeRow({
            instanceTag: current.rowId,
            source: input.source,
            configured: configuredFrom(input.source, draft, sourceInstanceId),
            configuredAtMs: current.value.configuredAtMs,
        }), current.revision, options);
        return written ? { kind: 'reconfigured', sourceInstanceId } : CONFLICT;
    }

    const successor = await readRow(sourceInstances, nextInstanceTag, options);
    if (successor && !configuredSourceInstanceIsOwnedBy(successor.value, input.source)) return INVALID_CALLER;
    if (successor && successor.value.lifecycle !== CORPUS_SOURCE_INSTANCE_LIFECYCLE.active) return CONFLICT;

    const successorId = successor?.value.configured.instance.sourceInstanceId
        ?? input.mintSourceInstanceId();
    const result = await sourceInstances.batch([
        {
            kind: 'put',
            value: toCorpusStoredValue(retiredRow(current.value, 'reconfigured')),
            expectedRevision: current.revision,
        },
        {
            kind: 'put',
            value: toCorpusStoredValue(activeRow({
                instanceTag: nextInstanceTag,
                source: input.source,
                configured: configuredFrom(input.source, draft, successorId),
                configuredAtMs: successor?.value.configuredAtMs ?? input.nowMs,
            })),
            expectedRevision: successor ? successor.revision : 'absent',
        },
    ], options);
    if (result.status !== 'updated') return CONFLICT;
    return successor
        ? { kind: 'reused', sourceInstanceId: successorId }
        : { kind: 'reconfigured', sourceInstanceId: successorId };
}

/**
 * `reactivate` — the only way back for a row the user removed.
 *
 * It restores a preexisting row and reuses its exact stable ref, so every
 * durable Session link and pin keeps pointing at the same canonical entries. A
 * draft naming a different tuple is a different source instance and cannot be
 * folded onto this row.
 */
async function reactivateInstance(
    input: CorpusAdministerConfiguredSourceInstanceInputV1,
    current: CorpusRowV1<CorpusSourceInstanceRowV1>,
    draft: TriageSourceInstanceDraftV1,
    draftInstanceTag: string,
    options?: PluginCancellationOptions,
): Promise<CorpusSourceInstanceAdministrationResultV1> {
    const sourceInstanceId = current.value.configured.instance.sourceInstanceId;
    if (draftInstanceTag !== current.rowId) return CONFLICT;
    if (current.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active) {
        return { kind: 'active', sourceInstanceId };
    }
    const written = await putRow(input.collections.sourceInstances, activeRow({
        instanceTag: current.rowId,
        source: input.source,
        configured: configuredFrom(input.source, draft, sourceInstanceId),
        configuredAtMs: current.value.configuredAtMs,
    }), current.revision, options);
    return written ? { kind: 'reactivated', sourceInstanceId } : CONFLICT;
}

/** `remove` — retire as `userRemoved`. Automatic discovery can never reverse it. */
async function removeInstance(
    collections: InstanceCollections,
    current: CorpusRowV1<CorpusSourceInstanceRowV1>,
    options?: PluginCancellationOptions,
): Promise<CorpusSourceInstanceAdministrationResultV1> {
    const sourceInstanceId = current.value.configured.instance.sourceInstanceId;
    if (current.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired) {
        // An already retired row is idempotent success only when it is retired
        // for this exact reason; another reason is a different lifecycle fact
        // and stays as it is.
        return current.value.retiredReason === 'userRemoved'
            ? { kind: 'removed', sourceInstanceId }
            : CONFLICT;
    }
    const written = await putRow(
        collections.sourceInstances,
        retiredRow(current.value, 'userRemoved'),
        current.revision,
        options,
    );
    return written ? { kind: 'removed', sourceInstanceId } : CONFLICT;
}

/**
 * Retire one Triage-owned configured source through the same lifecycle writer.
 *
 * Mounted Triage UI is the owner of this Collection, so it does not impersonate
 * an admitted source contribution merely to remove its own row. The row lookup,
 * lifecycle transition and CAS remain exactly the daemon Action's domain path.
 */
export async function removeConfiguredSourceInstance(input: Readonly<{
    collections: InstanceCollections;
    sourceInstanceId: string;
    signal?: AbortSignal;
}>): Promise<CorpusSourceInstanceAdministrationResultV1> {
    const options = input.signal ? { signal: input.signal } : undefined;
    const current = await findConfiguredSourceInstanceRow(
        input.collections.sourceInstances,
        input.sourceInstanceId,
        options,
    );
    return current ? await removeInstance(input.collections, current, options) : INVALID_CALLER;
}

export async function administerConfiguredSourceInstance(
    input: CorpusAdministerConfiguredSourceInstanceInputV1,
): Promise<CorpusSourceInstanceAdministrationResultV1> {
    const options = input.signal ? { signal: input.signal } : undefined;
    const { request } = input;

    // The account binding a draft carries must be the purpose the caller's
    // admitted descriptor declares. Anything else would let one source persist
    // a configuration reaching another purpose's Connected Accounts.
    if (request.kind !== 'remove' && request.draft.binding.purpose !== input.declaredPurpose) {
        return INVALID_CALLER;
    }

    if (request.kind === 'create') {
        const instanceTag = await deriveConfiguredSourceInstanceTag(input.collections.sourceInstances, {
            source: input.source,
            binding: request.draft.binding,
            localInstanceKey: request.draft.localInstanceKey,
        }, options);
        return await createInstance(input, request.draft, instanceTag, options);
    }

    const current = await findConfiguredSourceInstanceRow(
        input.collections.sourceInstances,
        request.sourceInstanceId,
        options,
    );
    // An unknown or another source's instance is a caller failure, not a
    // storage conflict: the caller named something it does not own.
    if (!current || !configuredSourceInstanceIsOwnedBy(current.value, input.source)) return INVALID_CALLER;

    if (request.kind === 'remove') return await removeInstance(input.collections, current, options);

    const draftInstanceTag = await deriveConfiguredSourceInstanceTag(input.collections.sourceInstances, {
        source: input.source,
        binding: request.draft.binding,
        localInstanceKey: request.draft.localInstanceKey,
    }, options);

    return request.kind === 'reconfigure'
        ? await reconfigureInstance(input, current, request.draft, draftInstanceTag, options)
        : await reactivateInstance(input, current, request.draft, draftInstanceTag, options);
}
