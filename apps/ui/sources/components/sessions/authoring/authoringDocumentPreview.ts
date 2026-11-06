import type { MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import type { AgentInputDocumentPreviewReference } from '@/components/sessions/agentInput/components/agentInputDocumentPreviewTypes';
import { resolveComposerReferenceChipLabel } from '@/components/sessions/agentInput/composerReferenceChipLabel';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import {
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    placePositionlessComposerReferences,
} from '@/components/sessions/composer/composerScopeAdapters';

/**
 * The one picture of a portable authored document (text plus positionless references) that is not
 * being edited: each reference is placed on its token and drawn as the chip the live composer draws.
 * `exact` carries the host's retained occurrences when they are the same document, so a duplicated
 * token keeps its exact chip. A read-only reader (a Run's authored Input) passes none.
 */
export function projectAuthoringDocumentPreview(
    document: Readonly<{ text: string; references: readonly MentionRefV1[] }>,
    exact?: Readonly<{ text: string; structuredInputMentions: readonly ComposerStructuredInputMention[] }> | null,
): Readonly<{ text: string; references: readonly AgentInputDocumentPreviewReference[] }> {
    const text = exact?.text ?? document.text;
    const mentions = exact?.structuredInputMentions ?? composerStructuredMentionsFromReferences({
        references: placePositionlessComposerReferences({ text, references: document.references }),
        existing: [],
    });
    return { text, references: projectComposerDocumentPreviewReferences(text, mentions) };
}

/**
 * The chips of a composer text whose references are already placed (the live field's own mentions, or a
 * read-only reading card's): each exact range with the label the live composer draws for it.
 */
export function projectComposerDocumentPreviewReferences(
    text: string,
    mentions: readonly ComposerStructuredInputMention[],
): readonly AgentInputDocumentPreviewReference[] {
    return composerReferencesFromStructuredMentions({ text, mentions }).map((reference) => ({
        start: reference.start,
        end: reference.end,
        ref: reference.ref,
        label: resolveComposerReferenceChipLabel(reference),
        ...(parseMentionRefV1(reference.ref) === null ? { unavailable: true } : {}),
    }));
}
