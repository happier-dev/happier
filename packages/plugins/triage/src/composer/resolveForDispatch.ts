import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import {
    raceWithTimeout,
    throwIfAborted,
    type RaceWithTimeoutResult,
} from '@happier-dev/plugin-sdk/async';
import {
    normalizeTriageSingleLineV1,
    truncateTriageUtf8V1,
    type TriageConfiguredSourceInstanceV1,
    type TriageEntryRefV1,
    type TriageGetInputV1,
    type TriageGetResultV1,
    type TriageSourceEntrySnapshotV1,
    type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
    indexTriageAdmittedSourcesV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { qualifyEntryLocalRef } from '../corpus/fold/qualify.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { reconcileMergedSuccessor } from '../sessions/reconcileMergedSuccessor.js';
import { parseTriageComposerEntryAttachmentValue } from './attachmentValue.js';

/**
 * Fresh exact resolution immediately before an Agent dispatch
 * (`core/COMPOSER.md` §5).
 *
 * The persisted attachment value carries identity plus the one routing hint and
 * nothing else — no snapshot, no prose — so this is
 * where an attached entry is actually read — under the exact connection the
 * user attached it with, through the currently admitted source contribution,
 * on every dispatch including queued, restarted and retried Messages. Anything
 * remembered from attach time would send the model a pull request as it was
 * hours ago.
 *
 * It resolves; it does not repair. There is no retry loop, no successor
 * following, no account substitution, no new Session link and no queue. A
 * blocked attachment is reported as blocked and the canonical host owns the
 * all-or-none dispatch refusal, because a partially resolved selection is a
 * prompt that quietly omits something the user attached.
 *
 * One thing it does own, because it is the only place a `merged(successor)`
 * observation is produced: the single durable continuity effect that answer has
 * (`core/CORPUS.md` §3.3). The dispatch outcome is unaffected — a successor is
 * still a different entry and is still blocked — but the user's existing
 * Session links must not be stranded on a predecessor nobody will open again,
 * so the link owner retargets them inside the observation that produced the
 * evidence. It never touches a pin: `corpus/marks/setPinned.ts` is the single
 * `user-marks` writer.
 */

/**
 * The context budget for one entry.
 *
 * The platform ceiling is 16 KiB per resolution, which is far more than the
 * Tier-A facts of one entry can honestly fill; a bound near the real content
 * keeps eight attached entries from crowding out the user's own prose. It is
 * derived from the source contract rather than guessed: title, summary and
 * scope are each bounded at `MAX_TRIAGE_TEXT_UTF8_BYTES_V1` (512 bytes), and
 * this leaves room for all three plus the identity line.
 */
export const MAX_TRIAGE_DISPATCH_CONTEXT_UTF8_BYTES_V1 = 2048;

/**
 * The host-created `get` handle, taken from the admitted contribution itself
 * rather than restated from the published schema.
 *
 * Restating it as `AdmittedTargetedOperationExecutionHandle<TriageGetInputV1,
 * ...>` looks equivalent and is not: a composable schema's pre-parse input type
 * and its parse result differ (`binding.account` is `unknown` before parsing),
 * so the restated handle is a *different* type from the one the contribution
 * actually carries. Deriving it removes both the restatement and the mismatch.
 */
export type TriageAdmittedGetOperationV1 = TriageAdmittedSourceV1['operations']['get'];

export type TriageAdmittedGetExecutorV1 = (
    operation: TriageAdmittedGetOperationV1,
    input: TriageGetInputV1,
    options?: PluginCancellationOptions,
) => Promise<TriageGetResultV1>;

export type TriageEntryDispatchDepsV1 = Readonly<{
    /** The `source-instances` Collection. This resolver never writes it. */
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>;
    /**
     * The `session-links` Collection, passed straight to the link owner. This
     * resolver never reads or writes it itself, and creates no link.
     */
    sessionLinks: CorpusCollectionsV1['sessionLinks'];
    /** The current admitted view of this target's own sources point. */
    readAdmittedSources: (options?: PluginCancellationOptions) => Promise<readonly TriageAdmittedSourceV1[]>;
    executeGet: TriageAdmittedGetExecutorV1;
    signal?: AbortSignal;
    /** Owner-private test injection; never a source-facing deadline override. */
    getDeadlineMs?: number;
}>;

/** Private per-invocation deadline; owner tests inject a short duration. */
const TRIAGE_DISPATCH_GET_DEADLINE_MS = 10_000;

/** One attached record as the canonical resolve request carries it. */
export type TriageEntryDispatchAttachmentV1 = Readonly<{
    instanceId: string;
    key: string;
    value: unknown;
}>;

export type TriageEntryDispatchRequestV1 = Readonly<{
    attachments: readonly TriageEntryDispatchAttachmentV1[];
}>;

export type TriageEntryDispatchOutcomeV1 =
    | Readonly<{ instanceId: string; status: 'ready'; context: string }>
    | Readonly<{
        instanceId: string;
        status: 'unavailable' | 'notFound' | 'invalid' | 'failed';
        retryable: boolean;
        message?: string;
    }>;

export type TriageEntryDispatchResultV1 = Readonly<{
    attachments: readonly TriageEntryDispatchOutcomeV1[];
}>;

/**
 * The Tier-A projection one resolved entry contributes.
 *
 * Facts only: what the entry is, where it lives, what state it is in and what
 * it says about itself. No prompt framing, delimiter fence or instruction
 * wrapper — the host owns escaping and framing, and a resolver that writes its
 * own makes two owners of it. No locator either: a web URL or routing token is
 * mutable routing, not an identity or status fact, and the attachment value
 * deliberately carries neither.
 */
export function projectTriageDispatchContext(input: Readonly<{
    entryRef: TriageEntryRefV1;
    snapshot: TriageSourceEntrySnapshotV1;
}>): string {
    const { entryRef, snapshot } = input;
    const state = snapshot.state.nativeLabel ?? snapshot.state.presentation;
    const lines = [
        `${entryRef.kindId} ${entryRef.entryId} in ${snapshot.scopeLabel}`,
        `state: ${state}`,
        `title: ${snapshot.title}`,
        ...(snapshot.summary === undefined ? [] : [`summary: ${snapshot.summary}`]),
    ];
    // Provider text is already single-line by contract, but this resolver is the
    // last hop before model-visible text and normalizing is cheap insurance
    // against a line break turning one fact into two.
    const projected = lines.map(normalizeTriageSingleLineV1).join('\n');
    return truncateTriageUtf8V1(projected, MAX_TRIAGE_DISPATCH_CONTEXT_UTF8_BYTES_V1).value;
}
function blocked(
    instanceId: string,
    status: 'unavailable' | 'notFound' | 'invalid' | 'failed',
    retryable: boolean,
    message?: string,
): TriageEntryDispatchOutcomeV1 {
    return message === undefined
        ? { instanceId, status, retryable }
        : { instanceId, status, retryable, message };
}

/**
 * Whether a failed read is worth trying again.
 *
 * The source's own classification decides. A rate limit and a transient blip
 * both clear on their own; an authentication or permission refusal needs a
 * person, and an unsupported contract needs a release.
 */
function retryableFailure(failure: TriageSourceFailureV1): boolean {
    return failure.class === 'transient' || failure.class === 'rateLimit';
}

async function readActiveConfiguredInstances(
    deps: TriageEntryDispatchDepsV1,
): Promise<ReadonlyMap<string, TriageConfiguredSourceInstanceV1>> {
    const options: PluginCancellationOptions | undefined = deps.signal ? { signal: deps.signal } : undefined;
    const page = await readActiveConfiguredSourceRows(deps.sourceInstances, options);

    // Keyed by the stable target-minted id the attachment carries. A storage
    // tag is never the lookup: it is mode-dependent and reprojected, while the
    // attached ref is neither.
    const configured = new Map<string, TriageConfiguredSourceInstanceV1>();
    for (const row of page.rows) {
        configured.set(row.configured.instance.sourceInstanceId, row.configured);
    }
    return configured;
}

function sameLocalRef(
    left: Readonly<{ kindId: string; collisionScope: string; entryId: string }>,
    right: Readonly<{ kindId: string; collisionScope: string; entryId: string }>,
): boolean {
    return left.kindId === right.kindId
        && left.collisionScope === right.collisionScope
        && left.entryId === right.entryId;
}

export async function resolveTriageEntryForDispatch(
    request: TriageEntryDispatchRequestV1,
    deps: TriageEntryDispatchDepsV1,
): Promise<TriageEntryDispatchResultV1> {
    throwIfAborted(deps.signal);
    const options: PluginCancellationOptions | undefined = deps.signal ? { signal: deps.signal } : undefined;
    const [configured, admitted] = await Promise.all([
        readActiveConfiguredInstances(deps),
        deps.readAdmittedSources(options),
    ]);
    throwIfAborted(deps.signal);
    const admittedByQualifiedId = indexTriageAdmittedSourcesV1(admitted);

    const attachments: TriageEntryDispatchOutcomeV1[] = [];
    for (const attachment of request.attachments) {
        throwIfAborted(deps.signal);
        attachments.push(await resolveOne(attachment, {
            configured,
            admittedByQualifiedId,
            executeGet: deps.executeGet,
            sessionLinks: deps.sessionLinks,
            options,
            callerSignal: deps.signal,
            getDeadlineMs: deps.getDeadlineMs ?? TRIAGE_DISPATCH_GET_DEADLINE_MS,
        }));
    }
    return { attachments };
}

async function resolveOne(
    attachment: TriageEntryDispatchAttachmentV1,
    context: Readonly<{
        configured: ReadonlyMap<string, TriageConfiguredSourceInstanceV1>;
        admittedByQualifiedId: ReadonlyMap<string, TriageAdmittedSourceV1>;
        executeGet: TriageAdmittedGetExecutorV1;
        sessionLinks: CorpusCollectionsV1['sessionLinks'];
        options: PluginCancellationOptions | undefined;
        callerSignal: AbortSignal | undefined;
        getDeadlineMs: number;
    }>,
): Promise<TriageEntryDispatchOutcomeV1> {
    const parsed = parseTriageComposerEntryAttachmentValue(attachment.value);
    if (parsed.status !== 'valid') {
        return blocked(attachment.instanceId, 'invalid', false, parsed.reason === 'sourceMismatch'
            ? 'This entry was attached under a connection to a different source.'
            : 'This attachment can no longer be read.');
    }
    const { entryRef, sourceInstance, lastKnownLocator } = parsed.value;

    // 1. The current admitted contribution named by the entry itself — never a
    //    Triage-local source registry and never a source-id branch.
    const contribution = context.admittedByQualifiedId.get(renderSourceQualifiedId(entryRef.source));
    if (contribution === undefined) {
        return blocked(attachment.instanceId, 'unavailable', false, 'Its source is no longer installed.');
    }

    // 2. The exact attached connection, reauthorized by the source itself when
    //    it receives the configured record. Another instance that can see the
    //    same entry is NOT a substitute: it dispatches under credentials the
    //    user did not choose.
    const instance = context.configured.get(sourceInstance.sourceInstanceId);
    if (
        instance === undefined
        || instance.instance.source.pluginId !== entryRef.source.pluginId
        || instance.instance.source.localId !== entryRef.source.localId
    ) {
        return blocked(attachment.instanceId, 'unavailable', false, 'Its connection is no longer configured.');
    }

    // 3. The source's authoritative read. No handle is retained past this call.
    //
    //    The attached routing hint travels with it, unchanged. It is the only
    //    evidence that can name the provider scope of an entry an ACCOUNT-WIDE
    //    connection discovered — the configured instance names none — and this
    //    resolver is not the parser of a source's own opaque token, so it never
    //    rewrites, shortens or re-derives one. An absent hint stays absent
    //    rather than becoming an empty locator the source would interpret.
    const deadline = new AbortController();
    const getOptions: PluginCancellationOptions = {
        signal: context.callerSignal === undefined
            ? deadline.signal
            : AbortSignal.any([context.callerSignal, deadline.signal]),
    };
    let settled: RaceWithTimeoutResult<TriageGetResultV1>;
    try {
        settled = await raceWithTimeout(
            context.executeGet(
                contribution.operations.get,
                {
                    v: 1,
                    instance,
                    localRef: {
                        kindId: entryRef.kindId,
                        collisionScope: entryRef.collisionScope,
                        entryId: entryRef.entryId,
                    },
                    ...(lastKnownLocator === undefined ? {} : { lastKnownLocator }),
                },
                getOptions,
            ),
            context.getDeadlineMs,
        );
    } catch (error) {
        // A synchronous invocation failure has the same caller-visible path as
        // a rejected source read.
        settled = { type: 'rejected', error };
    } finally {
        deadline.abort();
    }

    throwIfAborted(context.callerSignal);
    if (settled.type === 'timeout' || settled.type === 'rejected') {
        // An invocation that never produced an observation is a failure of the
        // read, not a conclusion about the entry — it is retryable precisely
        // because nothing was learned.
        return blocked(attachment.instanceId, 'failed', true, 'This entry could not be read.');
    }
    const observation = settled.value;

    // 4. Typed outcomes only. Nothing here rebinds, follows or repairs.
    //
    //    This is also the gate the routing hint rests on. A route is mutable and
    //    an entry number is not unique across provider scopes, so a stale hint
    //    can reach a DIFFERENT entry that answers perfectly well — and acting on
    //    it would run the user's prompt against the wrong pull request. The
    //    immutable identity is compared to what was attached, and a disagreement
    //    is refused with the one remedy that actually repairs it: read the list
    //    again and attach the entry from its current route.
    if (!sameLocalRef(observation.localRef, entryRef)) {
        return blocked(
            attachment.instanceId,
            'invalid',
            false,
            'Its source answered about a different entry. Refresh and attach it again.',
        );
    }
    switch (observation.kind) {
        case 'present':
            return {
                instanceId: attachment.instanceId,
                status: 'ready',
                context: projectTriageDispatchContext({ entryRef, snapshot: observation.snapshot }),
            };
        case 'absent':
            return blocked(attachment.instanceId, 'notFound', false, 'It no longer exists in its source.');
        case 'merged': {
            // The one durable effect of this answer, run before it is reported
            // so the evidence and its consequence stay in one invocation.
            const successor = qualifyEntryLocalRef({
                source: entryRef.source,
                declaredKindIds: contribution.descriptor?.kinds.map((kind) => kind.id) ?? [],
                localRef: observation.successor,
            });
            // A successor the invoked descriptor does not declare is not a
            // successor this aggregate can address, and a merge nobody can
            // qualify moves nothing. The dispatch answer is the same either way.
            if (successor.status === 'qualified') {
                await reconcileMergedSuccessor({
                    collections: { sessionLinks: context.sessionLinks },
                    entryRef,
                    successorEntryRef: successor.entryRef,
                    ...(context.options?.signal ? { signal: context.options.signal } : {}),
                });
            }
            // The successor is a different entry. Resolving it would send the
            // model something the user never attached; the user removes and
            // reattaches deliberately.
            return blocked(attachment.instanceId, 'notFound', false, 'It was merged into another entry.');
        }
        case 'unresolved':
            return blocked(
                attachment.instanceId,
                'failed',
                retryableFailure(observation.failure),
                'Its source could not confirm it.',
            );
    }
}
