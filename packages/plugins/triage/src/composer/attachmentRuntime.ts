import { admitSourceFacts } from '@happier-dev/triage-protocol/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    ComposerAttachmentResolveRequestV1,
    ComposerAttachmentResolveRequestV2,
    ComposerAttachmentResolveResultV1,
    ComposerAttachmentRuntime,
    PluginScopedInvocationContextV1,
} from '@happier-dev/plugin-sdk';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { resolveTriageEntryForDispatch } from './resolveForDispatch.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import { readTriageComposerForgeEvidenceV1 } from './attachmentValue.js';

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
    const resolve = async (
        request: ComposerAttachmentResolveRequestV1 | ComposerAttachmentResolveRequestV2,
        context: PluginInvocationContext | PluginScopedInvocationContextV1,
    ): Promise<ComposerAttachmentResolveResultV1> => {
            const collections = bindCorpusCollections(requireTriageAccountStorage(context));
            const sessionId = 'sessionId' in request ? request.sessionId
                : request.scope.kind === 'session' ? request.scope.sessionId : undefined;
            return await resolveTriageEntryForDispatch({ attachments: request.attachments,
                ...(sessionId === undefined ? {} : { sessionId }) }, {
                sourceRelations: createTriageSourceSessionRelations(context, collections),
                sessionLinks: collections.sessionLinks,
                executeGet: async (operation, getInput, options) => admitSourceFacts(await context.services.actions
                    .executeAdmittedTargetedOperation(operation, getInput, options ?? {})),
                ...(context.signal === undefined ? {} : { signal: context.signal }),
            });
    };
    return {
        async prepareForSend(request) {
            return { attachments: request.attachments.map(attachment => {
                const forgeEvidence = readTriageComposerForgeEvidenceV1(attachment.value);
                return { instanceId: attachment.instanceId, status: 'ready' as const, value: attachment.value,
                    ...(forgeEvidence === null ? {} : { forgeEvidence }) };
            }) };
        },
        resolveForDispatch: resolve,
        resolveForDispatchV2: resolve,
    };
}
