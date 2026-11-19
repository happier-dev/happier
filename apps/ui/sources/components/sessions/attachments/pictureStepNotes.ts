import { formatStepNotes } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { readAgentInputImageNumbers } from '../agentInput/agentInputContracts';
import type { AttachmentDraft } from './attachmentDraftModel';
import { projectAttachmentDraftToAgentInputRowItem } from './attachmentDraftPresentation';

/**
 * The words a picture's numbered comments send with it. The numbers are burned into the picture; the notes
 * live on its step marks in the draft (`edit.document`) and reach the agent as "[Image #N]" followed by the
 * numbered list, after the person's own text, so the composer text stays theirs while they edit. A Browser
 * annotation already carries its whole marks document to the agent, so it adds no second copy here.
 */
export function appendPictureStepNotes(
  message: string,
  drafts: readonly AttachmentDraft[],
): string {
  let numbers: ReadonlyMap<string, number> | null = null;
  const blocks: string[] = [];
  for (const draft of drafts) {
    if (!draft.edit || draft.browserAnnotation) continue;
    const steps = formatStepNotes(draft.edit.document);
    if (!steps) continue;
    numbers ??= readAgentInputImageNumbers(
      drafts.map(projectAttachmentDraftToAgentInputRowItem),
    );
    const number = numbers.get(draft.id);
    blocks.push(number === undefined ? steps : `[Image #${number}]\n${steps}`);
  }
  if (blocks.length === 0) return message;
  const text = message.trimEnd();
  return text ? `${text}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n');
}
