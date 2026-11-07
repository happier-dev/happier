export type GithubMarkdownDisplaySegmentV1 =
  | Readonly<{ kind: 'markdown'; value: string }>
  | Readonly<{ kind: 'attachment'; media: 'asset' | 'video'; url: string }>;

type SourceLine = Readonly<{ bytes: string; content: string }>;
type OpenFence = Readonly<{ marker: '`' | '~'; length: number }>;

const VIDEO_PATH_EXTENSION = /\.(?:m4v|mov|mp4|ogg|ogv|webm)$/i;

function splitSourceLines(source: string): readonly SourceLine[] {
  if (source.length === 0) return Object.freeze([]);
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character !== '\n' && character !== '\r') continue;
    const end = character === '\r' && source[index + 1] === '\n'
      ? index + 2
      : index + 1;
    lines.push(Object.freeze({
      bytes: source.slice(start, end),
      content: source.slice(start, index),
    }));
    start = end;
    index = end - 1;
  }
  if (start < source.length) {
    lines.push(Object.freeze({ bytes: source.slice(start), content: source.slice(start) }));
  }
  return Object.freeze(lines);
}

function readFenceOpener(line: string): OpenFence | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  const run = match?.[1];
  if (run === undefined) return null;
  return Object.freeze({ marker: run[0] as '`' | '~', length: run.length });
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = /^(?: {0,3})(`+|~+)[ \t]*$/.exec(line);
  const run = match?.[1];
  return run !== undefined && run[0] === fence.marker && run.length >= fence.length;
}

function readHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function standaloneUrlAttachment(line: string): GithubMarkdownDisplaySegmentV1 | null {
  const value = line.trim();
  if (value.length === 0 || /\s/.test(value)) return null;
  const url = readHttpUrl(value);
  if (url === null) return null;
  if (url.hostname.toLowerCase() === 'github.com'
    && url.pathname.startsWith('/user-attachments/assets/')
    && url.pathname.length > '/user-attachments/assets/'.length
  ) {
    return Object.freeze({ kind: 'attachment' as const, media: 'asset' as const, url: value });
  }
  if (VIDEO_PATH_EXTENSION.test(url.pathname)) {
    return Object.freeze({ kind: 'attachment' as const, media: 'video' as const, url: value });
  }
  return null;
}

function readTagSource(tag: string): string | null {
  const match = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value !== undefined && readHttpUrl(value) !== null ? value : null;
}

const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;
const HTML_ANCHOR = /<a\s[^<>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^<>]*>(.*?)<\/a\s*>/gi;
const HTML_IMAGE = /<img\b[^<>]*>/gi;
const HTML_LINE_BREAK = /<br\s*\/?>/gi;
const HTML_VIDEO_SOURCE = /<(?:video|source)\b[^<>]*>/gi;

function stripHtmlTags(value: string): string {
  return value.replace(HTML_VIDEO_SOURCE, (tag) => {
    const source = readTagSource(tag);
    return source === null ? '' : `[${source}](${source})`;
  }).replace(HTML_IMAGE, (tag: string) => {
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const label = alt?.[1] ?? alt?.[2] ?? '';
    const source = readTagSource(tag);
    if (source === null) return label;
    const destination = new URL(source).href.replaceAll('(', '%28').replaceAll(')', '%29');
    return `![${label.replace(/[\\[\]]/g, '\\$&')}](${destination})`;
  })
    .replace(HTML_LINE_BREAK, ' ')
    .replace(HTML_TAG, '');
}

/** One prose stretch (no code span) with its HTML turned into the text a reader would see. */
function htmlProseToText(value: string): string {
  return stripHtmlTags(value.replace(HTML_ANCHOR, (_match, double?: string, single?: string, inner = '') => {
    const href = (double ?? single ?? '').trim();
    const label = stripHtmlTags(inner).trim();
    return readHttpUrl(href) === null ? label : `[${label.length === 0 ? href : label}](${href})`;
  }));
}

/** GitHub renders HTML; this display shows its text. Inline code spans stay exact. */
function htmlLineToText(line: string): string {
  return line.split(/(`[^`]*`)/).map((part, index) => (index % 2 === 1 ? part : htmlProseToText(part))).join('');
}

/**
 * Removes what GitHub does not show (HTML comments) and reduces the rest of its inline HTML to
 * Markdown: links and images retain their destinations, any other tag becomes nothing. Fenced and
 * indented code remain exact source bytes, like the attachment projection below.
 */
function sanitizeGithubHtmlForDisplay(source: string): string {
  if (!source.includes('<')) return source;
  let fence: OpenFence | null = null;
  let inComment = false;
  let result = '';
  for (const line of splitSourceLines(source)) {
    const ending = line.bytes.slice(line.content.length);
    if (fence !== null) {
      result += line.bytes;
      if (closesFence(line.content, fence)) fence = null;
      continue;
    }
    const opener = inComment ? null : readFenceOpener(line.content);
    if (opener !== null) {
      fence = opener;
      result += line.bytes;
      continue;
    }
    if (!inComment && (line.content.startsWith('    ') || line.content.startsWith('\t'))) {
      result += line.bytes;
      continue;
    }
    let rest = line.content;
    let visible = '';
    for (;;) {
      if (inComment) {
        const close = rest.indexOf('-->');
        if (close === -1) { rest = ''; break; }
        rest = rest.slice(close + 3);
        inComment = false;
        continue;
      }
      const open = rest.indexOf('<!--');
      if (open === -1) break;
      visible += rest.slice(0, open);
      rest = rest.slice(open + 4);
      inComment = true;
    }
    const text = htmlLineToText(visible + rest);
    // A line that held only a comment or tags leaves no blank line behind.
    if (text.trim().length === 0 && line.content.trim().length > 0) continue;
    result += text + ending;
  }
  return result;
}

function videoBlockAttachment(
  lines: readonly SourceLine[],
  start: number,
): Readonly<{ segment: GithubMarkdownDisplaySegmentV1 | null; nextLine: number }> | null {
  const opening = lines[start]?.content.trim();
  if (opening === undefined || !/^<video\b/i.test(opening)) return null;

  const block: string[] = [];
  let nextLine = start;
  for (; nextLine < lines.length; nextLine += 1) {
    const content = lines[nextLine]!.content;
    // A new block or code fence belongs to the outer walk. Returning the scanned
    // stretch even on failure prevents repeated unclosed blocks rescanning a suffix.
    if (nextLine > start && (/^<video\b/i.test(content.trim()) || readFenceOpener(content) !== null)) break;
    block.push(content);
    const close = /<\/video\s*>/i.exec(content);
    if (close !== null) {
      nextLine += 1;
      if (content.slice(close.index + close[0].length).trim().length !== 0) break;
      const tags = block.join('\n').match(HTML_VIDEO_SOURCE) ?? [];
      const source = tags.map(readTagSource).find((value): value is string => value !== null);
      if (source === undefined) break;
      return Object.freeze({
        segment: Object.freeze({ kind: 'attachment' as const, media: 'video' as const, url: source }),
        nextLine,
      });
    }
  }
  return Object.freeze({ segment: null, nextLine });
}

/** GitHub's five alert types (`> [!NOTE]`), as GitHub titles them. */
const GITHUB_ALERT_TITLES: Readonly<Record<string, string>> = Object.freeze({
  NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution',
});
const GITHUB_ALERT_MARKER = /^([ ]{0,3}>[ ]?)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\r?\n?)$/u;

/** A GitHub alert's marker line becomes its bold title inside the same quote, as GitHub renders it. */
function projectGithubAlertMarker(bytes: string): string {
  const match = GITHUB_ALERT_MARKER.exec(bytes);
  return match === null ? bytes : `${match[1]}**${GITHUB_ALERT_TITLES[match[2]!]}**${match[3]}`;
}

/**
 * Separates the small attachment vocabulary GitHub documents from Markdown.
 *
 * Fenced and indented code remain exact source bytes. In particular, an
 * unterminated or mismatched fence never exposes its apparent links as media.
 */
export function projectGithubMarkdownForDisplay(
  source: string,
): readonly GithubMarkdownDisplaySegmentV1[] {
  if (source.length === 0) return Object.freeze([]);
  const lines = splitSourceLines(source);
  const result: GithubMarkdownDisplaySegmentV1[] = [];
  let markdown = '';
  let fence: OpenFence | null = null;

  const flushMarkdown = (): void => {
    if (markdown.length === 0) return;
    result.push(Object.freeze({ kind: 'markdown' as const, value: sanitizeGithubHtmlForDisplay(markdown) }));
    markdown = '';
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (fence !== null) {
      markdown += line.bytes;
      if (closesFence(line.content, fence)) fence = null;
      index += 1;
      continue;
    }

    const opener = readFenceOpener(line.content);
    if (opener !== null) {
      fence = opener;
      markdown += line.bytes;
      index += 1;
      continue;
    }

    // Four leading spaces or one tab is Markdown's indented-code plane. It is
    // never inspected for links or HTML attachment blocks.
    if (line.content.startsWith('    ') || line.content.startsWith('\t')) {
      markdown += line.bytes;
      index += 1;
      continue;
    }

    const urlAttachment = standaloneUrlAttachment(line.content);
    if (urlAttachment !== null) {
      flushMarkdown();
      result.push(urlAttachment);
      index += 1;
      continue;
    }

    const videoAttachment = videoBlockAttachment(lines, index);
    if (videoAttachment !== null) {
      if (videoAttachment.segment === null) {
        markdown += lines.slice(index, videoAttachment.nextLine).map((sourceLine) => sourceLine.bytes).join('');
      } else {
        flushMarkdown();
        result.push(videoAttachment.segment);
      }
      index = videoAttachment.nextLine;
      continue;
    }

    markdown += projectGithubAlertMarker(line.bytes);
    index += 1;
  }

  flushMarkdown();
  return Object.freeze(result);
}

/** The projection as one Markdown string, for a surface that quotes a body instead of segmenting it. */
export function githubMarkdownDisplayText(source: string): string {
  return projectGithubMarkdownForDisplay(source)
    .map((segment) => (segment.kind === 'markdown' ? segment.value : `${segment.url}\n`))
    .join('');
}
