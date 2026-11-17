import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ComposerTransactionV1 } from '@happier-dev/protocol/plugins/ui/composer';
import {
    buildSessionInputForgeEvidenceAttachmentValueV1,
    SESSION_INPUT_FORGE_EVIDENCE_ATTACHMENT_IDENTITY_V1,
} from '@happier-dev/protocol/sessions/messages/sessionInputForgeEvidenceAttachmentV1';

import { planComposerAttachmentAppend } from '@/components/sessions/composer/composerAttachmentAppend';
import {
    applyMountedComposerPresentationTransaction,
    readMountedComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Composes into the answering client's ordinary mounted Session draft. */
export const composeSessionInputHandoff: NonNullable<ActionExecutorDeps['sessionInputHandoffCompose']> = async ({ session, input, context }) => {
    // Generic plugin-authored attachments need their actual caller's contribution
    // admission. Never silently drop them or credit them to the native evidence owner.
    if (input.attachments?.length) return 'composerUnavailable';
    const scope = createServerAccountScope(session.serverId, context.runtimeAccountId);
    if (!scope) return 'composerUnavailable';
    const ref = { kind: 'session' as const, sessionId: session.sessionId };
    const snapshot = readMountedComposerPresentationSnapshot({ ref, scope });
    if (!snapshot) return 'composerUnavailable';
    const appended = planComposerAttachmentAppend({ snapshot, items: [{ text: input.text }] });
    const operations: ComposerTransactionV1['operations'] = [
        { kind: 'text.insert', position: { offset: snapshot.text.length }, text: appended.text.slice(snapshot.text.length) },
        ...(input.forgeEvidence ? [{
            kind: 'attachment.add' as const,
            attachmentLocalId: SESSION_INPUT_FORGE_EVIDENCE_ATTACHMENT_IDENTITY_V1.localId,
            value: buildSessionInputForgeEvidenceAttachmentValueV1(input.forgeEvidence),
        }] : []),
    ];
    const result = applyMountedComposerPresentationTransaction({
        scope, ref, transaction: { expectedRevision: snapshot.revision, operations },
        ...(context.signal ? { signal: context.signal } : {}),
        ...(input.forgeEvidence ? { attachmentContributor: SESSION_INPUT_FORGE_EVIDENCE_ATTACHMENT_IDENTITY_V1 } : {}),
    });
    return result.status === 'applied' ? 'composed' : 'composerUnavailable';
};
