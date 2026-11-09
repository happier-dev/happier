import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { INLINE_REFERENCE_HREF_PREFIX_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { projectInlineReferenceLabelsV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { parseMarkdownSyntax, splitMarkdownIntoBlockSources } from '../streaming/splitMarkdownIntoBlockSources';
import { hasMarkdownPathCharacterReference, resolveWorkspaceFileReference } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import {
    type MarkdownInlineReference,
    type MarkdownInlineReferences,
} from '../markdownInlineReferences';
import {
    isStreamingIncompleteLinkHref,
    STREAMING_INCOMPLETE_LINK_HREF,
} from '../streaming/streamingMarkdownRepairConfig';

function stripTerminalLineAnchor(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '');
}

export type MarkdownLinkNormalizationOptions = Readonly<{ workspaceFileLinks?: boolean }>;

function isLocalPathLikeMarkdownTarget(value: string, options: MarkdownLinkNormalizationOptions): boolean {
    const pathCandidate = stripTerminalLineAnchor(value);
    if (!pathCandidate) return false;
    return (
        pathCandidate.startsWith('/')
        || pathCandidate.startsWith('./')
        || pathCandidate.startsWith('../')
        || pathCandidate.startsWith('\\\\')
        || /^[A-Za-z]:[\\/]/.test(pathCandidate)
        || /[\\/]/.test(pathCandidate)
        || options.workspaceFileLinks === true && (
            pathCandidate.startsWith('#')
            || resolveWorkspaceFileReference({ url: pathCandidate, workspacePath: null }) !== null
        )
    );
}

function isExternallyOpenableMarkdownLink(value: string): boolean {
    const lower = value.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:');
}

export function normalizeMarkdownLinkUrl(raw: string, options: MarkdownLinkNormalizationOptions = {}): string | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    if (isStreamingIncompleteLinkHref(trimmed)) return null;

    const lowerTrimmed = trimmed.toLowerCase();
    // Markdown unescapes punctuation in URI schemes before emitting the href.
    const candidate = (lowerTrimmed.startsWith('www.') ? `https://${trimmed}` : trimmed)
        .replace(/^([A-Za-z](?:[A-Za-z0-9]|\\?[+.-])*)\\?:/, (_match, scheme: string) => `${scheme.replace(/\\/g, '')}:`);
    const lower = candidate.toLowerCase();

    if (lower.startsWith(INLINE_REFERENCE_HREF_PREFIX_V1)) return null;
    if (lower.startsWith('javascript:') || lower.startsWith('data:')) return null;
    if (/\s|[\u0000-\u001F\u007F]/.test(candidate)) return null;
    if (isExternallyOpenableMarkdownLink(candidate) || lower.startsWith('file://')) return candidate;
    if (hasMarkdownPathCharacterReference(candidate)) return null;
    // A URI's payload can contain slashes without becoming a workspace path.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate)) return null;
    if (isLocalPathLikeMarkdownTarget(candidate, options)) return candidate;
    return null;
}

function indexClosingMarkdownDelimiters(value: string): ReadonlyMap<number, number> {
    const closingByOpening = new Map<number, number>();
    const squareBracketStack: number[] = [];
    const parenthesisStack: number[] = [];

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === '[') {
            squareBracketStack.push(index);
            continue;
        }
        if (char === '(') {
            parenthesisStack.push(index);
            continue;
        }
        if (char === ']') {
            const opening = squareBracketStack.pop();
            if (opening != null) closingByOpening.set(opening, index);
            continue;
        }
        if (char !== ')') continue;
        const opening = parenthesisStack.pop();
        if (opening != null) closingByOpening.set(opening, index);
    }

    return closingByOpening;
}

function extractMarkdownLinkDestination(raw: string): Readonly<{
    destination: string;
    suffix: string;
}> | null {
    const trimmed = raw.trimStart();
    if (!trimmed) return null;

    if (trimmed.startsWith('<')) {
        const closingIndex = trimmed.indexOf('>');
        if (closingIndex <= 1) return null;
        return {
            destination: trimmed.slice(1, closingIndex),
            suffix: trimmed.slice(closingIndex + 1),
        };
    }

    let depth = 0;
    let index = 0;
    for (; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === '(') {
            depth += 1;
            continue;
        }
        if (char === ')') {
            if (depth === 0) break;
            depth -= 1;
            continue;
        }
        if (/\s/.test(char) && depth === 0) break;
    }

    const destination = trimmed.slice(0, index);
    return destination
        ? { destination, suffix: trimmed.slice(index) }
        : null;
}

/** `[text](scheme:target)` cited by an author, resolved by the owner of that scheme. */
function resolveInlineReferenceLink(
    destination: string,
    sourceToken: string,
    references: MarkdownInlineReferences | undefined,
    resolved: Map<string, MarkdownInlineReference>,
): string | null {
    if (!references) return null;
    const prefixed = destination.startsWith(INLINE_REFERENCE_HREF_PREFIX_V1);
    const ref = prefixed ? destination.slice(INLINE_REFERENCE_HREF_PREFIX_V1.length) : destination;
    if (!prefixed && (!references.scheme || !destination.startsWith(`${references.scheme}:`))) return null;
    if (references.scheme && !ref.startsWith(`${references.scheme}:`)) return null;
    const target = references.scheme ? ref.slice(references.scheme.length + 1) : ref;
    const resolve: (target: string, sourceToken?: string) => MarkdownInlineReference | null = references.resolve;
    const reference = target ? resolve(target, sourceToken) : null;
    if (!reference) return null;
    const href = `${INLINE_REFERENCE_HREF_PREFIX_V1}${ref}`;
    resolved.set(href, reference);
    const label = reference.label.replace(/[[\]\\]/g, (char) => `\\${char}`);
    return `[${label}](${href})`;
}

function normalizeExplicitMarkdownLinks(
    markdown: string,
    references?: MarkdownInlineReferences,
    resolved: Map<string, MarkdownInlineReference> = new Map(),
    options: MarkdownLinkNormalizationOptions = {},
): string {
    let out = '';
    const closingDelimiters = indexClosingMarkdownDelimiters(markdown);
    const codeRanges = new Map<number, number>();
    if (references || markdown.includes(INLINE_REFERENCE_HREF_PREFIX_V1)) {
        parseMarkdownSyntax(markdown).iterate({ enter(node) {
            if (node.name !== 'InlineCode' && node.name !== 'FencedCode' && node.name !== 'CodeBlock') return;
            codeRanges.set(node.from, node.to);
            return false;
        } });
    }
    for (let index = 0; index < markdown.length; index += 1) {
        const char = markdown[index];
        const codeEnd = codeRanges.get(index);
        if (codeEnd !== undefined) {
            out += projectInlineReferenceLabelsV1(markdown.slice(index, codeEnd));
            index = codeEnd - 1;
            continue;
        }
        if (char !== '[' || markdown[index - 1] === '!') {
            out += char;
            continue;
        }

        const labelEnd = closingDelimiters.get(index) ?? -1;
        if (labelEnd < 0 || markdown[labelEnd + 1] !== '(') {
            out += char;
            continue;
        }
        const destinationStart = labelEnd + 1;
        const destinationEnd = closingDelimiters.get(destinationStart) ?? -1;
        if (destinationEnd < 0) {
            out += char;
            continue;
        }

        const label = markdown.slice(index + 1, labelEnd);
        const extracted = extractMarkdownLinkDestination(markdown.slice(destinationStart + 1, destinationEnd));
        if (!extracted) {
            out += markdown.slice(index, destinationEnd + 1);
            index = destinationEnd;
            continue;
        }
        const reference = resolveInlineReferenceLink(extracted.destination, markdown.slice(index, destinationEnd + 1), references, resolved);
        if (reference) {
            out += reference;
            index = destinationEnd;
            continue;
        }
        // A link whose URL is still streaming carries the repair placeholder. It is not an
        // openable destination — `normalizeMarkdownLinkUrl` rejects it, and that rejection
        // is what keeps a press inert — but it must survive as a destination so the label
        // renders inside its Link node from first paint instead of re-parenting when the
        // real URL arrives.
        const normalizedDestination = isStreamingIncompleteLinkHref(extracted.destination)
            ? STREAMING_INCOMPLETE_LINK_HREF
            : normalizeMarkdownLinkUrl(extracted.destination, options);
        out += normalizedDestination
            ? `[${label}](${normalizedDestination}${extracted.suffix})`
            : label;
        index = destinationEnd;
    }
    return out;
}

/**
 * Transcript Markdown images fail closed by default. An opted-in document moves
 * standalone images to the host's resolver-backed special blocks; inline images
 * remain alt text, so arbitrary destinations never reach the package renderer.
 */
export function applyEnrichedMarkdownImagePolicy(markdown: string, options: Readonly<{ imagesEnabled?: boolean }> = {}): string {
    if (options.imagesEnabled) {
        let cursor = 0;
        let withoutStandaloneImages = '';
        for (const source of splitMarkdownIntoBlockSources(markdown)) {
            if (!source.imageBlock) continue;
            withoutStandaloneImages += markdown.slice(cursor, source.sourceStart);
            cursor = source.sourceStart + source.source.length;
        }
        return applyEnrichedMarkdownImagePolicy(withoutStandaloneImages + markdown.slice(cursor));
    }
    const closingDelimiters = indexClosingMarkdownDelimiters(markdown);
    const chunks: string[] = [];
    const frames: Array<{
        cursor: number;
        end: number;
    }> = [{
        cursor: 0,
        end: markdown.length,
    }];

    while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.cursor >= frame.end) {
            frames.pop();
            continue;
        }

        const imageStart = frame.cursor;
        if (markdown[imageStart] !== '!' || markdown[imageStart + 1] !== '[') {
            chunks.push(markdown[imageStart]!);
            frame.cursor += 1;
            continue;
        }

        const labelStart = imageStart + 1;
        const labelEnd = closingDelimiters.get(labelStart) ?? -1;
        if (labelEnd < 0 || labelEnd >= frame.end) {
            chunks.push(markdown[imageStart]!);
            frame.cursor += 1;
            continue;
        }

        const destinationStart = labelEnd + 1;
        let imageEnd = labelEnd;
        if (markdown[destinationStart] === '(') {
            const destinationEnd = closingDelimiters.get(destinationStart) ?? -1;
            if (destinationEnd < 0 || destinationEnd >= frame.end) {
                chunks.push(markdown[imageStart]!);
                frame.cursor += 1;
                continue;
            }
            imageEnd = destinationEnd;
        }
        if (markdown[destinationStart] === '[') {
            const referenceEnd = closingDelimiters.get(destinationStart) ?? -1;
            if (referenceEnd >= 0 && referenceEnd < frame.end) {
                imageEnd = referenceEnd;
            }
        }

        // Shortcut reference images can resolve through a later definition.
        frame.cursor = imageEnd + 1;
        frames.push({
            cursor: labelStart + 1,
            end: labelEnd,
        });
    }

    return chunks.join('');
}

const autolinkTargetPattern = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)/;

function normalizeMarkdownAutolinks(markdown: string, options: MarkdownLinkNormalizationOptions): string {
    return markdown.replace(/<([^>\n]+)>/g, (fullMatch, rawTarget: string) => {
        if (!autolinkTargetPattern.test(rawTarget)) return fullMatch;
        const normalized = normalizeMarkdownLinkUrl(rawTarget, options);
        return normalized ? `<${normalized}>` : rawTarget;
    });
}

function normalizeMarkdownReferenceDefinitions(markdown: string, options: MarkdownLinkNormalizationOptions): string {
    if (!markdown.includes(']:')) return markdown;
    const chunks: string[] = [];
    let cursor = 0;
    parseMarkdownSyntax(markdown).iterate({ enter(node) {
        if (node.name !== 'LinkReference') return;
        const url = node.node.getChild('URL');
        if (!url) return false;
        const extracted = extractMarkdownLinkDestination(markdown.slice(url.from, url.to));
        const normalized = extracted ? normalizeMarkdownLinkUrl(extracted.destination, options) : null;
        if (normalized) {
            chunks.push(markdown.slice(cursor, url.from), normalized);
            cursor = url.to;
        } else {
            // Without a definition, its references remain ordinary text in every renderer.
            chunks.push(markdown.slice(cursor, node.from));
            cursor = node.to;
        }
        return false;
    } });
    return chunks.length ? chunks.join('') + markdown.slice(cursor) : markdown;
}

export function sanitizeEnrichedMarkdownLinkTargets(markdown: string, options: MarkdownLinkNormalizationOptions = {}): string {
    return sanitizeEnrichedMarkdownWithInlineReferences(markdown, undefined, options).markdown;
}

/** Sanitized Markdown plus the inline references the caller's resolver placed in it, by rendered href. */
export function sanitizeEnrichedMarkdownWithInlineReferences(markdown: string, references?: MarkdownInlineReferences, options: MarkdownLinkNormalizationOptions = {}): Readonly<{
    markdown: string;
    references: ReadonlyMap<string, MarkdownInlineReference>;
}> {
    const resolved = new Map<string, MarkdownInlineReference>();
    const withoutImages = applyEnrichedMarkdownImagePolicy(String(markdown ?? ''));
    const normalizedReferences = normalizeMarkdownReferenceDefinitions(withoutImages, options);
    return { markdown: normalizeMarkdownAutolinks(normalizeExplicitMarkdownLinks(normalizedReferences, references, resolved, options), options), references: resolved };
}

export async function openMarkdownLinkUrl(raw: string, openUrl: (url: string) => Promise<unknown> = openExternalUrl): Promise<void> {
    const normalized = normalizeMarkdownLinkUrl(raw);
    if (!normalized || !isExternallyOpenableMarkdownLink(normalized)) return;
    await openUrl(normalized);
}
