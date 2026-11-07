import { projectMarkdownFindText } from '@/components/markdown/rendering/markdownFindProjection';
import { splitMarkdownRenderSegments } from '@/components/markdown/rendering/splitMarkdownRenderSegments';

type SourceRange = Readonly<{ start: number; end: number }>;

/** An open suggestion based on the revision being read, at its passage's source range. */
export type DocSuggestion = Readonly<{
  id: string;
  range: SourceRange;
  after: string;
}>;

/** A run of the Doc as read: its own Markdown at its own source offset, or one painted suggestion. */
export type DocBodySegment =
  | Readonly<{ kind: 'prose'; start: number; markdown: string }>
  | Readonly<{
      kind: 'suggestion';
      id: string;
      start: number;
      markdown: string;
      before: string;
      after: string;
    }>;

export type DocSuggestionPaint = Readonly<{
  segments: readonly DocBodySegment[];
  /** The suggestions the body shows; their cards then leave the diff to the body. */
  painted: ReadonlySet<string>;
}>;

/** A block that opens with a heading, list, quote, fence, table or HTML marker is not a plain paragraph. */
const NOT_A_PARAGRAPH = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||<)/;

/**
 * Where a Doc's current suggestions are painted in its body (lab K1-A): each in the paragraph that holds
 * it, read as that paragraph's words with the suggested words struck and inserted, while the rest of the
 * Doc stays its own Markdown at its own source offsets. Block boundaries are the Markdown owner's.
 * Only plain paragraphs are painted: a heading, list or table drawn as words would lose its shape, so a
 * suggestion there (and a second one in a painted paragraph) keeps its diff on its card. `null` when
 * nothing is painted.
 */
export function planDocSuggestionPaint(
  input: Readonly<{
    markdown: string;
    suggestions: readonly DocSuggestion[];
  }>,
): DocSuggestionPaint | null {
  const { markdown } = input;
  if (input.suggestions.length === 0) return null;
  const blocks = splitMarkdownRenderSegments({
    markdown,
    streamingMode: 'static',
    splitEnrichedSourceRanges: true,
  }).filter(
    (block) =>
      block.type === 'enriched-markdown' &&
      // The owner may normalize before splitting; only a block that is the Doc's own bytes is placed.
      markdown.slice(
        block.sourceStart,
        block.sourceStart + block.sourceLength,
      ) === block.markdown &&
      !NOT_A_PARAGRAPH.test(block.markdown),
  );
  const segments: DocBodySegment[] = [];
  const painted = new Set<string>();
  let cursor = 0;
  for (const suggestion of [...input.suggestions].sort(
    (left, right) => left.range.start - right.range.start,
  )) {
    const { start, end } = suggestion.range;
    const block = blocks.find(
      (candidate) =>
        candidate.sourceStart >= cursor &&
        candidate.sourceStart <= start &&
        end <= candidate.sourceStart + candidate.sourceLength,
    );
    if (!block || start >= end) continue;
    const blockEnd = block.sourceStart + block.sourceLength;
    const offset = block.sourceStart;
    const revised =
      block.markdown.slice(0, start - offset) +
      suggestion.after +
      block.markdown.slice(end - offset);
    if (block.sourceStart > cursor)
      segments.push({
        kind: 'prose',
        start: cursor,
        markdown: markdown.slice(cursor, block.sourceStart),
      });
    segments.push({
      kind: 'suggestion',
      id: suggestion.id,
      start: block.sourceStart,
      markdown: block.markdown,
      before: projectMarkdownFindText(block.markdown).text,
      after: projectMarkdownFindText(revised).text,
    });
    painted.add(suggestion.id);
    cursor = blockEnd;
  }
  if (painted.size === 0) return null;
  if (cursor < markdown.length)
    segments.push({
      kind: 'prose',
      start: cursor,
      markdown: markdown.slice(cursor),
    });
  return { segments, painted };
}
