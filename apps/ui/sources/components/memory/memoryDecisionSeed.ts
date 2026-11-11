import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

/** What opens the Save as decision sheet: the exact committed message, and what to prefill from it. */
export type SaveMemoryDecisionSeed = Readonly<{
  sourceMessageRef: CoordinationMessageRefV1;
  /** The decision as one line; the person edits it before saving. */
  text: string;
  reason?: string;
  /** The message itself, quoted as the decision's source (Markdown). */
  quote?: string;
}>;

const FENCE = /^\s*(```|~~~)/;
/** A heading, table row or rule, or a line that is only punctuation (a JSON brace): structure, not prose. */
const NOT_PROSE = /^\s*(#{1,6}\s|\||[-*_=]{3,}\s*$|[^\p{L}\p{N}]*$)/u;
/** A label that introduces what follows ("Result:", "Summary:"). */
const LABEL = /:\s*$/;

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2')
    .trim();
}

/** The first sentence, ending before a period (kept for ? and !); a period inside a number does not end it. */
function firstSentence(line: string): string {
  const match = /^(.*?)([.!?])(?=\s|$)/.exec(line);
  if (!match) return line;
  return match[2] === '.' ? match[1]!.trim() : `${match[1]}${match[2]}`.trim();
}

/**
 * The decision starts as the answer's first prose sentence, without markup; an answer with no prose line
 * (a label and a code block) leaves it empty for the person to write. The reason is the person's own:
 * the sheet shows the answer itself as its quoted source, so nothing is copied into Reason.
 */
export function seedMemoryDecisionFromMessage(
  sourceMessageRef: CoordinationMessageRefV1,
  message: string,
): SaveMemoryDecisionSeed {
  let inFence = false;
  for (const raw of message.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || NOT_PROSE.test(raw) || LABEL.test(raw)) continue;
    const text = firstSentence(stripInlineMarkdown(raw));
    if (text.length > 0) return { sourceMessageRef, text, quote: message };
  }
  return { sourceMessageRef, text: '', quote: message };
}
