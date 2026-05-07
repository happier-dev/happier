import { openExternalUrl } from '@/utils/url/openExternalUrl';

function stripTerminalLineAnchor(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '');
}

function isLocalPathLikeMarkdownTarget(value: string): boolean {
    const pathCandidate = stripTerminalLineAnchor(value);
    if (!pathCandidate) return false;

    return (
        pathCandidate.startsWith('/') ||
        pathCandidate.startsWith('./') ||
        pathCandidate.startsWith('../') ||
        pathCandidate.startsWith('\\\\') ||
        /^[A-Za-z]:[\\/]/.test(pathCandidate) ||
        /[\\/]/.test(pathCandidate)
    );
}

function isExternallyOpenableMarkdownLink(value: string): boolean {
    const lower = value.toLowerCase();
    return (
        lower.startsWith('http://') ||
        lower.startsWith('https://') ||
        lower.startsWith('mailto:')
    );
}

export function normalizeMarkdownLinkUrl(raw: string): string | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;

    const lowerTrimmed = trimmed.toLowerCase();
    const candidate = lowerTrimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
    const lower = candidate.toLowerCase();

    if (lower.startsWith('javascript:') || lower.startsWith('data:')) return null;
    if (/\s|[\u0000-\u001F\u007F]/.test(candidate)) return null;

    if (isExternallyOpenableMarkdownLink(candidate) || lower.startsWith('file://')) {
        return candidate;
    }

    if (isLocalPathLikeMarkdownTarget(candidate)) {
        return candidate;
    }

    return null;
}

const autolinkTargetPattern = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)/;

function findClosingDelimiter(
    value: string,
    start: number,
    delimiters: Readonly<{ open: string; close: string }>,
): number {
    let depth = 0;

    for (let index = start; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === delimiters.open) {
            depth += 1;
            continue;
        }
        if (char !== delimiters.close) {
            continue;
        }
        depth -= 1;
        if (depth === 0) {
            return index;
        }
    }

    return -1;
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
        if (/\s/.test(char) && depth === 0) {
            break;
        }
    }

    const destination = trimmed.slice(0, index);
    if (!destination) return null;
    return {
        destination,
        suffix: trimmed.slice(index),
    };
}

function normalizeExplicitMarkdownLinks(markdown: string): string {
    let out = '';

    for (let index = 0; index < markdown.length; index += 1) {
        const char = markdown[index];
        if (char !== '[' || markdown[index - 1] === '!') {
            out += char;
            continue;
        }

        const labelEnd = findClosingDelimiter(markdown, index, { open: '[', close: ']' });
        if (labelEnd < 0 || markdown[labelEnd + 1] !== '(') {
            out += char;
            continue;
        }

        const destinationStart = labelEnd + 1;
        const destinationEnd = findClosingDelimiter(markdown, destinationStart, { open: '(', close: ')' });
        if (destinationEnd < 0) {
            out += char;
            continue;
        }

        const label = markdown.slice(index + 1, labelEnd);
        const rawDestination = markdown.slice(destinationStart + 1, destinationEnd);
        const extracted = extractMarkdownLinkDestination(rawDestination);
        if (!extracted) {
            out += markdown.slice(index, destinationEnd + 1);
            index = destinationEnd;
            continue;
        }

        const normalizedDestination = normalizeMarkdownLinkUrl(extracted.destination);
        out += normalizedDestination
            ? `[${label}](${normalizedDestination}${extracted.suffix})`
            : label;
        index = destinationEnd;
    }

    return out;
}

function normalizeMarkdownAutolinks(markdown: string): string {
    return markdown.replace(/<([^>\n]+)>/g, (fullMatch, rawTarget: string) => {
        if (!autolinkTargetPattern.test(rawTarget)) {
            return fullMatch;
        }

        const normalized = normalizeMarkdownLinkUrl(rawTarget);
        return normalized ? `<${normalized}>` : rawTarget;
    });
}

export function sanitizeEnrichedMarkdownLinkTargets(markdown: string): string {
    const value = String(markdown ?? '');
    return normalizeMarkdownAutolinks(normalizeExplicitMarkdownLinks(value));
}

export async function openMarkdownLinkUrl(raw: string): Promise<boolean> {
    const normalized = normalizeMarkdownLinkUrl(raw);
    if (!normalized) return false;
    if (!isExternallyOpenableMarkdownLink(normalized)) return false;
    return openExternalUrl(normalized);
}
