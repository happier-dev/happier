import type { ScmPullRequestReference } from '@happier-dev/protocol';

function parsePositiveInt(value: string): number | null {
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePullRequestNumberFromUrl(value: string): number | null {
    const match =
        /\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/i.exec(value)
        ?? /\/-\/merge_requests\/([1-9][0-9]*)(?:[/?#].*)?$/i.exec(value);
    return match?.[1] ? parsePositiveInt(match[1]) : null;
}

function parsePullRequestNumberFromCheckoutCommand(value: string): number | null {
    const match = /^\s*(?:gh\s+pr|glab\s+mr)\s+checkout\s+([1-9][0-9]*)(?:\s|$)/i.exec(value);
    return match?.[1] ? parsePositiveInt(match[1]) : null;
}

export function parsePullRequestReferenceInput(value: string): ScmPullRequestReference | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
    const numeric = parsePositiveInt(withoutHash);
    if (numeric != null) return { number: numeric };

    const commandNumber = parsePullRequestNumberFromCheckoutCommand(trimmed);
    if (commandNumber != null) return { number: commandNumber };

    const urlNumber = parsePullRequestNumberFromUrl(trimmed);
    if (urlNumber != null) return { url: trimmed };

    try {
        const url = new URL(trimmed);
        if (url.protocol === 'http:' || url.protocol === 'https:') return null;
    } catch {
        return { headBranch: trimmed };
    }

    return { headBranch: trimmed };
}
