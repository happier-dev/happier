import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    ComposerAttachmentResolveRequestV1,
    ComposerAttachmentResolveResultV1,
    ComposerAttachmentRuntime,
} from '@happier-dev/plugin-sdk';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { resolveTriageEntryForDispatch } from './resolveForDispatch.js';

/**
 * The registered half of the one declared `entry` attachment lifecycle role.
 *
 * The resolver itself owns every decision; this binds it to the exact
 * invocation context the host supplies, exactly as the Action handlers do, and
 * adds no dispatch, cache, retry or registry of its own. Without it the
 * manifest declares a role the host invokes and nothing answers, which reaches
 * the user as an attached entry the model silently never sees.
 */
export function createTriageEntryAttachmentRuntime(): ComposerAttachmentRuntime {
    return {
        async resolveForDispatch(
            request: ComposerAttachmentResolveRequestV1,
            context: PluginInvocationContext,
        ): Promise<ComposerAttachmentResolveResultV1> {
            return await resolveTriageEntryForDispatch({ attachments: request.attachments }, {
                sourceInstances: bindCorpusCollections(requireTriageAccountStorage(context)).sourceInstances,
                readAdmittedSources: async (options) => {
                    const observation = context.services.targetedContributions.observeForSelf(
                        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
                        { onInvalidated: () => {} },
                    );
                    try {
                        const snapshot = await observation.readCurrent(options);
                        return snapshot.contributions;
                    } finally {
                        observation.dispose();
                    }
                },
                executeGet: async (operation, getInput, options) => await context.services.actions
                    .executeAdmittedTargetedOperation(operation, getInput, options ?? {}),
                ...(context.signal === undefined ? {} : { signal: context.signal }),
            });
        },
    };
}
