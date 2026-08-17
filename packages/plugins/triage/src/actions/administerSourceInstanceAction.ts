import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
    type TriageSourceAdministrationActionInputV1,
    type TriageSourceAdministrationActionResultV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import {
    administerConfiguredSourceInstance,
    findConfiguredSourceInstanceRow,
    type CorpusSourceInstanceAdministrationV1,
} from '../corpus/configuration/administerConfiguredSourceInstance.js';
import type {
    TriageInitialScanOwnerV1,
    TriageInitialScanPassV1,
} from '../corpus/configuration/initialScan.js';
import { runTriageScanPass } from '../projection/scanPass.js';
import { resolveTriageCallerSource } from './callerSource.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

/**
 * The one public, target-owned source-administration Action.
 *
 * This is the entry point the whole aggregate depends on: the composed list
 * reads active `source-instances` rows, and until a source Settings surface
 * invokes this Action there are none, so the product cannot be used at all.
 *
 * The request carries no source, plugin or contribution identity. The host
 * stamps the immediate caller, and this handler resolves that caller's *own*
 * currently admitted V1 source contribution at this target's own point — the
 * point admits at most one contribution per contributor, so the caller's plugin
 * id resolves it exactly. A caller with none, or one whose contribution is
 * retired, is rejected before the writer or the initial pass runs.
 *
 * Every mutation is delegated to the single canonical writer. This handler
 * decides nothing about lifecycle, mints no identity of its own, and never sees
 * a provider credential: the source owns its native account, organization and
 * repository choices, and hands over exactly one strict draft.
 */

/** The initial-scan seam. `activate` supplies the one process-local owner. */
export type TriageAdministerInitialScanV1 = Pick<TriageInitialScanOwnerV1, 'request' | 'retire'>;

export type TriageAdministerSourceInstanceActionOptionsV1 = Readonly<{
    initialScan: TriageAdministerInitialScanV1;
    /** Mints one stable private UUID for a genuinely new configured tuple. */
    mintSourceInstanceId: () => string;
    nowMs: () => number;
}>;

/** Whether this arm's success means a newly readable configuration exists. */
function schedulesInitialScan(kind: TriageSourceAdministrationActionInputV1['kind']): boolean {
    return kind !== 'remove';
}

function requestFrom(
    input: TriageSourceAdministrationActionInputV1,
): CorpusSourceInstanceAdministrationV1 {
    return input.kind === 'remove'
        ? { kind: 'remove', sourceInstanceId: input.sourceInstanceId }
        : input.kind === 'create'
            ? { kind: 'create', draft: input.draft }
            : { kind: input.kind, sourceInstanceId: input.sourceInstanceId, draft: input.draft };
}

/**
 * One bounded pass over the just-configured instance, through the exact
 * admitted operation handle the caller's contribution carries.
 *
 * Nothing provider-derived is persisted by it. The pass exists so that explicit
 * configuration reaches the provider once — proving the configuration and
 * settling this process's pacing and backoff state for that instance — rather
 * than leaving the first read to whenever a page happens to mount.
 */
function initialPassFor(input: Readonly<{
    sourceInstances: CorpusCollectionHandleV1;
    contribution: TriageAdmittedSourceV1;
    source: PluginContributionIdentity;
    sourceInstanceId: string;
    executeScan: PluginInvocationContext['services']['actions']['executeAdmittedTargetedOperation'];
    nowMs: () => number;
}>): TriageInitialScanPassV1 {
    return async ({ signal }) => {
        const options: PluginCancellationOptions = { signal };
        const row = await findConfiguredSourceInstanceRow(
            input.sourceInstances,
            input.sourceInstanceId,
            options,
        );
        // Retired, reconfigured or lost between the commit and the drain: an
        // interruption, never provider evidence about the source.
        if (!row) return { kind: 'interrupted' };

        const declaredKindIds = input.contribution.descriptor?.kinds.map((kind) => kind.id) ?? [];
        if (declaredKindIds.length === 0) return { kind: 'interrupted' };

        const pass = await runTriageScanPass({
            lanes: [{
                sourceInstanceId: input.sourceInstanceId,
                source: input.source,
                declaredKindIds,
                configured: row.value.configured,
                scan: async (scanInput, scanOptions) => await input.executeScan(
                    input.contribution.operations.scan,
                    scanInput,
                    scanOptions ?? {},
                ),
            }],
            pageLimit: MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
            observationBudget: MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
            nowMs: input.nowMs,
            signal,
        });

        const health = pass.lanes[0]?.health;
        if (!health || health.kind === 'unavailable') return { kind: 'interrupted' };
        return health.kind === 'failed'
            ? { kind: 'failed', failure: health.failure }
            : { kind: 'completed' };
    };
}

export function createTriageAdministerSourceInstanceActionHandler(
    options: TriageAdministerSourceInstanceActionOptionsV1,
): ActionHandler<TriageSourceAdministrationActionInputV1, TriageSourceAdministrationActionResultV1> {
    return async (input, context: PluginInvocationContext) => {
        const cancellation: PluginCancellationOptions | undefined = context.signal
            ? { signal: context.signal }
            : undefined;
        const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));

        const resolution = await resolveTriageCallerSource(context, cancellation);
        if (resolution.kind === 'invalidCaller') return { kind: 'invalidCaller' };
        // The admitted view moved under this invocation, so the caller just
        // resolved is no longer the one the write would belong to.
        if (resolution.kind === 'currentnessConflict') return { kind: 'currentnessConflict' };
        const caller = resolution.caller;

        const result = await administerConfiguredSourceInstance({
            collections: { sourceInstances },
            source: caller.source,
            declaredPurpose: caller.declaredPurpose,
            request: requestFrom(input),
            nowMs: options.nowMs(),
            mintSourceInstanceId: options.mintSourceInstanceId,
            ...(context.signal ? { signal: context.signal } : {}),
        });
        if (result.kind === 'invalidCaller'
            || result.kind === 'conflict'
            || result.kind === 'atMaximum') {
            return result;
        }

        // Retirement first: a removed instance, and a reconfiguration that
        // moved to a new stable ref, must lose their in-flight pass before a
        // new one is requested.
        if (input.kind === 'remove' || (input.kind !== 'create' && input.sourceInstanceId !== result.sourceInstanceId)) {
            options.initialScan.retire(input.sourceInstanceId);
        }
        if (schedulesInitialScan(input.kind)) {
            // Scheduled, not awaited: the Settings surface gets its answer as
            // soon as the durable choice is committed. The coordinator owns the
            // pass, its cancellation and its outcome.
            void options.initialScan.request({
                sourceInstanceId: result.sourceInstanceId,
                pass: initialPassFor({
                    sourceInstances,
                    contribution: caller.contribution,
                    source: caller.source,
                    sourceInstanceId: result.sourceInstanceId,
                    executeScan: context.services.actions.executeAdmittedTargetedOperation,
                    nowMs: options.nowMs,
                }),
            });
        }
        return result;
    };
}
