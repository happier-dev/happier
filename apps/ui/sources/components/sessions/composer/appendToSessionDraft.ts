import type { ComposerTransactionResultV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { admitComposerDraftItems, type ComposerDraftAppendItem } from './admitComposerDraftItems';
import { projectAttachmentDraftToAgentInputRowItem } from '../attachments/attachmentDraftPresentation';
import { readSessionAttachmentDrafts, resolveSessionAttachmentDraftScope, writeSessionAttachmentDrafts } from '../attachments/sessionAttachmentDraftStore';
import { insertComposerAttachmentReferences } from '../presentation/sessionComposerPresentationTargets';
import { readAgentInputImageNumbers } from '../agentInput/agentInputContracts';
import type { SessionComposerDocumentBinding } from './existingSessionComposerDocumentOwner';
import type { ComposerPresentationDocumentMutation } from './composerDocumentOwner';

// Prepared images arrive as memory bytes or a native URI. Raw web File picking
// keeps its existing hook-owned preview lifetime rather than creating one here.
export type SessionDraftAppendItem = ComposerDraftAppendItem;
export type SessionDraftAppendInput = Readonly<{
    sessionTarget: ExactSessionMachineTargetIdentity;
    items: readonly SessionDraftAppendItem[];
    note?: string;
    windowText?: Readonly<{ text: string; name: string }>;
    sessionBinding?: SessionComposerDocumentBinding;
    discussionSource?: ComposerPresentationDocumentMutation['sessionDiscussionSelectionSourceV1'];
}>;
export type SessionDraftAppendResult = Exclude<ComposerTransactionResultV1, { status: 'applied' }>
    | (Extract<ComposerTransactionResultV1, { status: 'applied' }> & Readonly<{
        attachmentIds: readonly string[];
        imageNumbers: readonly number[];
    }>);

/** Main-renderer append owner; callers resolve native capture references before entering. */
export function appendToSessionDraft(input: SessionDraftAppendInput): SessionDraftAppendResult {
    const admission = admitComposerDraftItems(input);
    if (admission.status !== 'admitted') return admission;
    const result = insertComposerAttachmentReferences({ ref: { kind: 'session', sessionId: input.sessionTarget.sessionId },
        scope: input.sessionTarget, items: admission.items, placement: 'appendParagraph', sessionBinding: input.sessionBinding,
        discussionSource: input.discussionSource });
    if (result.status !== 'applied') return result;
    const scope = resolveSessionAttachmentDraftScope(input.sessionTarget);
    const drafts = [...readSessionAttachmentDrafts(scope), ...admission.drafts];
    writeSessionAttachmentDrafts(scope, drafts);
    const imageNumbers = readAgentInputImageNumbers(drafts.map(projectAttachmentDraftToAgentInputRowItem));
    return { ...result, attachmentIds: admission.drafts.map(draft => draft.id),
        imageNumbers: admission.drafts.flatMap(draft => {
            const number = imageNumbers.get(draft.id);
            return number === undefined ? [] : [number];
        }) };
}
