import type { ScmPullRequestReference } from '@happier-dev/protocol';

export function parsePullRequestNumberFromUrl(url: string): number | null {
    const match =
        /\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/i.exec(url)
        ?? /\/-\/merge_requests\/([1-9][0-9]*)(?:[/?#].*)?$/i.exec(url);
    if (!match?.[1]) return null;
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parsePullRequestNumberFromCheckoutCommand(command: string): number | null {
    const match = /^\s*(?:gh\s+pr|glab\s+mr)\s+checkout\s+([1-9][0-9]*)(?:\s|$)/i.exec(command);
    if (!match?.[1]) return null;
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function resolvePullRequestReferenceNumber(reference: ScmPullRequestReference): number | null {
    if ('number' in reference) return reference.number;
    if ('url' in reference) return parsePullRequestNumberFromUrl(reference.url);
    return null;
}

export function resolvePullRequestReferenceHead(reference: ScmPullRequestReference): string | null {
    if (!('headBranch' in reference)) return null;
    const headBranch = reference.headBranch.trim();
    return headBranch || null;
}
