import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1,
    type TriageConfiguredSourceInstanceRecordV1,
    type TriageReadConfiguredSourceInstancesInputV1,
    type TriageReadConfiguredSourceInstancesResultV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import {
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { configuredSourceInstanceIsOwnedBy } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { resolveTriageCallerSource } from './callerSource.js';

/**
 * The caller-scoped configured-instance read.
 *
 * `sources/administer-v1` has four lifecycle arms and three of them —
 * `reconfigure`, `remove`, `reactivate` — name a `sourceInstanceId` the caller
 * must already hold. Nothing published one, so a source Settings surface could
 * only ever ADD a source: it could not list what it had already configured and
 * therefore could not offer to change or remove it. This is the missing read,
 * and it is deliberately only a read — administration remains the sole writer.
 *
 * Scope is host-derived, never caller-supplied. The caller's own admitted V1
 * source contribution is resolved through the one caller owner, and a row is
 * returned only when `configured.instance.source` is exactly that contribution.
 * A source therefore cannot see another source's account binding, its
 * source-private configuration token, or even that it exists.
 */

const INVALID_CALLER: TriageReadConfiguredSourceInstancesResultV1 = Object.freeze({
    kind: 'invalidCaller',
});
const CURRENTNESS_CONFLICT: TriageReadConfiguredSourceInstancesResultV1 = Object.freeze({
    kind: 'currentnessConflict',
});

function recordFrom(row: CorpusSourceInstanceRowV1): TriageConfiguredSourceInstanceRecordV1 {
    return Object.freeze({
        v: 1,
        lifecycle: row.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active ? 'active' : 'retired',
        configured: row.configured,
    });
}

export type TriageReadConfiguredSourceInstancesDepsV1 = Readonly<{
    /** The `source-instances` Collection. This Action never writes it. */
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>;
    signal?: AbortSignal;
}>;

/**
 * Walk the declared lifecycle index and keep the caller's own rows.
 *
 * The walk is cursor-paged and covers both lifecycles, because a retired row is
 * exactly what an explicit reactivation restores. There is no second index
 * keyed on the owning source: an index value is plaintext server metadata even
 * on an E2EE Account, and adding one would publish which sources an Account has
 * configured to the server. The set it walks is the one the writer already
 * bounds — active rows are capped, and retired rows accumulate only when a user
 * reconfigures a connection onto a genuinely different account or key.
 *
 * It stops as soon as one row past the carryable maximum has been collected, so
 * a caller that owns more than the result can name is reported as `truncated`
 * rather than silently shortened.
 */
export async function readTriageConfiguredSourceInstances(
    source: PluginContributionIdentity,
    deps: TriageReadConfiguredSourceInstancesDepsV1,
): Promise<TriageReadConfiguredSourceInstancesResultV1> {
    const options: PluginCancellationOptions | undefined = deps.signal
        ? { signal: deps.signal }
        : undefined;
    const owned: TriageConfiguredSourceInstanceRecordV1[] = [];
    let cursor: string | undefined;
    do {
        const page = await deps.sourceInstances.query({
            index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
            order: 'asc',
            ...(cursor === undefined ? {} : { cursor }),
        }, options);
        for (const stored of page.rows) {
            const row = fromCorpusStoredRow<CorpusSourceInstanceRowV1>(stored).value;
            if (!configuredSourceInstanceIsOwnedBy(row, source)) continue;
            owned.push(recordFrom(row));
            if (owned.length > MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1) break;
        }
        cursor = owned.length > MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1
            ? undefined
            : page.nextCursor;
    } while (cursor !== undefined);

    return Object.freeze({
        kind: 'read',
        instances: Object.freeze(owned.slice(0, MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1)),
        status: owned.length > MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1 ? 'truncated' : 'complete',
    });
}

export function createTriageReadConfiguredSourceInstancesActionHandler(): ActionHandler<
    TriageReadConfiguredSourceInstancesInputV1,
    TriageReadConfiguredSourceInstancesResultV1
> {
    return async (_input, context: PluginInvocationContext) => {
        const cancellation: PluginCancellationOptions | undefined = context.signal
            ? { signal: context.signal }
            : undefined;
        const resolution = await resolveTriageCallerSource(context, cancellation);
        // The two refusals stay distinct: one says "you are not a configured
        // source", the other says "ask again". Collapsing them would tell a
        // Settings page whose admitted view moved mid-read that its own source
        // is not configured.
        if (resolution.kind === 'invalidCaller') return INVALID_CALLER;
        if (resolution.kind === 'currentnessConflict') return CURRENTNESS_CONFLICT;

        const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
        return await readTriageConfiguredSourceInstances(resolution.caller.source, {
            sourceInstances,
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}
