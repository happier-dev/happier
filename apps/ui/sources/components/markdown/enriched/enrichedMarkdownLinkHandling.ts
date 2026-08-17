import { openExternalUrl } from '@/utils/url/openExternalUrl';
import {
    isStreamingIncompleteLinkHref,
    STREAMING_INCOMPLETE_LINK_HREF,
} from '../streaming/streamingMarkdownRepairConfig';

function stripTerminalLineAnchor(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '');
}

function isLocalPathLikeMarkdownTarget(value: string): boolean {
    const pathCandidate = stripTerminalLineAnchor(value);
    if (!pathCandidate) return false;
    return (
        pathCandidate.startsWith('/')
        || pathCandidate.startsWith('./')
        || pathCandidate.startsWith('../')
        || pathCandidate.startsWith('\\\\')
        || /^[A-Za-z]:[\\/]/.test(pathCandidate)
        || /[\\/]/.test(pathCandidate)
    );
}

function isExternallyOpenableMarkdownLink(value: string): boolean {
    const lower = value.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:');
}

export function normalizeMarkdownLinkUrl(raw: string): string | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;

    const lowerTrimmed = trimmed.toLowerCase();
    const candidate = lowerTrimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
    const lower = candidate.toLowerCase();

    if (lower.startsWith('javascript:') || lower.startsWith('data:')) return null;
    if (/\s|[\u0000-\u001F\u007F]/.test(candidate)) return null;
    if (isExternallyOpenableMarkdownLink(candidate) || lower.startsWith('file://')) return candidate;
    if (isLocalPathLikeMarkdownTarget(candidate)) return candidate;
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

function normalizeExplicitMarkdownLinks(markdown: string): string {
    let out = '';
    const closingDelimiters = indexClosingMarkdownDelimiters(markdown);
    for (let index = 0; index < markdown.length; index += 1) {
        const char = markdown[index];
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
        // A link whose URL is still streaming carries the repair placeholder. It is not an
        // openable destination — `normalizeMarkdownLinkUrl` rejects it, and that rejection
        // is what keeps a press inert — but it must survive as a destination so the label
        // renders inside its Link node from first paint instead of re-parenting when the
        // real URL arrives.
        const normalizedDestination = isStreamingIncompleteLinkHref(extracted.destination)
            ? STREAMING_INCOMPLETE_LINK_HREF
            : normalizeMarkdownLinkUrl(extracted.destination);
        out += normalizedDestination
            ? `[${label}](${normalizedDestination}${extracted.suffix})`
            : label;
        index = destinationEnd;
    }
    return out;
}

/**
 * Transcript Markdown images fail closed. Structured session media is the only
 * image path with an authenticated owner, size bounds, and an explicit preview
 * grant, so arbitrary Markdown destinations never reach the package renderer.
 */
export function applyEnrichedMarkdownImagePolicy(markdown: string): string {
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

function normalizeMarkdownAutolinks(markdown: string): string {
    return markdown.replace(/<([^>\n]+)>/g, (fullMatch, rawTarget: string) => {
        if (!autolinkTargetPattern.test(rawTarget)) return fullMatch;
        const normalized = normalizeMarkdownLinkUrl(rawTarget);
        return normalized ? `<${normalized}>` : rawTarget;
    });
}

export function sanitizeEnrichedMarkdownLinkTargets(markdown: string): string {
    const withoutImages = applyEnrichedMarkdownImagePolicy(String(markdown ?? ''));
    return normalizeMarkdownAutolinks(normalizeExplicitMarkdownLinks(withoutImages));
}

export async function openMarkdownLinkUrl(raw: string): Promise<void> {
    const normalized = normalizeMarkdownLinkUrl(raw);
    if (!normalized || !isExternallyOpenableMarkdownLink(normalized)) return;
    await openExternalUrl(normalized);
}
