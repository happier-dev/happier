import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type {
    TriageSourceAdministrationActionInputV1,
    TriageSourceAdministrationActionResultV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import {
    administerConfiguredSourceInstance,
    type CorpusSourceInstanceAdministrationV1,
} from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { resolveTriageCallerSource } from './callerSource.js';

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
 * retired, is rejected before the writer runs.
 *
 * It reads no provider. Configuration is a durable choice, and the one producer
 * of provider observations is the aggregate list read itself: opening the list
 * or pressing **Refresh** performs the real scan through the mounted window's
 * single-flight owner. A second pass launched from here would be unpaced
 * against that owner and its observations would reach no reader.
 *
 * Every mutation is delegated to the single canonical writer. This handler
 * decides nothing about lifecycle, mints no identity of its own, and never sees
 * a provider credential: the source owns its native account, organization and
 * repository choices, and hands over exactly one strict draft.
 */

export type TriageAdministerSourceInstanceActionOptionsV1 = Readonly<{
    /** Mints one stable private UUID for a genuinely new configured tuple. */
    mintSourceInstanceId: () => string;
    nowMs: () => number;
}>;

function requestFrom(
    input: TriageSourceAdministrationActionInputV1,
): CorpusSourceInstanceAdministrationV1 {
    return input.kind === 'remove'
        ? { kind: 'remove', sourceInstanceId: input.sourceInstanceId }
        : input.kind === 'create'
            ? { kind: 'create', draft: input.draft }
            : { kind: input.kind, sourceInstanceId: input.sourceInstanceId, draft: input.draft };
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

        return await administerConfiguredSourceInstance({
            collections: { sourceInstances },
            source: caller.source,
            declaredPurpose: caller.declaredPurpose,
            request: requestFrom(input),
            nowMs: options.nowMs(),
            mintSourceInstanceId: options.mintSourceInstanceId,
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}
