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
    findConfiguredSourceInstanceRow,
    type CorpusSourceInstanceAdministrationV1,
} from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { isTriageHostActionCaller, resolveTriageCallerSource } from './callerSource.js';

/**
 * The one public, target-owned source-administration Action.
 *
 * This is the entry point the whole aggregate depends on: the composed list
 * reads active `source-instances` rows, and until a source Settings surface
 * invokes this Action there are none, so the product cannot be used at all.
 *
 * The host stamps the immediate caller. Plugins resolve their own admitted
 * source; host automated callers select an admitted source for create or resolve
 * it from the canonical configured row for lifecycle operations. A requested
 * address is not provenance. Retired contributions are rejected before writing.
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

        const configuredRow = isTriageHostActionCaller(context) && input.kind !== 'create'
            ? await findConfiguredSourceInstanceRow(sourceInstances, input.sourceInstanceId, cancellation)
            : null;
        const selectedSource = configuredRow?.value.configured.instance.source ?? input.source;
        if (configuredRow && input.source && (input.source.pluginId !== selectedSource?.pluginId
            || input.source.localId !== selectedSource?.localId)) return { kind: 'invalidCaller' };
        const resolution = await resolveTriageCallerSource(context, cancellation, selectedSource);
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
