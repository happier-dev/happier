import type { ScmPullRequestReference } from '@happier-dev/plugin-sdk/scm';

export type PullRequestReferenceParseResult =
    | Readonly<{ ok: true; reference: ScmPullRequestReference }>
    | Readonly<{ ok: false; error: string }>;

const NUMBER_REFERENCE_REGEX = /^#?([1-9]\d*)$/;
const CHECKOUT_COMMAND_REGEX = /^(?:gh\s+pr|glab\s+mr)\s+checkout\s+(.+)$/;
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;

function parsePullRequestNumber(value: string): number | null {
    const match = NUMBER_REFERENCE_REGEX.exec(value);
    if (!match?.[1]) return null;
    const number = Number(match[1]);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function parsePullRequestNumberFromUrl(url: URL): number | null {
    const segments = url.pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex((segment) =>
        segment === 'pull' || segment === 'pullrequest' || segment === 'merge_requests'
    );
    if (markerIndex < 0) return null;
    const rawNumber = segments[markerIndex + 1];
    return rawNumber ? parsePullRequestNumber(rawNumber) : null;
}

function isSafeHeadBranchReference(value: string): boolean {
    return Boolean(value)
        && value === value.trim()
        && !CONTROL_CHAR_REGEX.test(value)
        && !/\s/.test(value)
        && !value.startsWith('-')
        && !value.startsWith('+')
        && !value.startsWith('.')
        && !value.startsWith('/')
        && !value.endsWith('/')
        && !value.endsWith('.')
        && !value.endsWith('.lock')
        && !value.includes('\\')
        && !value.includes('//')
        && !value.includes('@{')
        && !value.includes('..')
        && !value.includes(':')
        && !value.includes('^')
        && !value.includes('~')
        && !value.includes('?')
        && !value.includes('*')
        && !value.includes('[');
}

export function parsePullRequestReference(input: string): PullRequestReferenceParseResult {
    const trimmed = input.trim();
    if (!trimmed) {
        return { ok: false, error: 'Pull request reference is required' };
    }

    const commandMatch = CHECKOUT_COMMAND_REGEX.exec(trimmed);
    const value = commandMatch?.[1]?.trim() ?? trimmed;
    if (!value) {
        return { ok: false, error: 'Pull request reference is required' };
    }

    const number = parsePullRequestNumber(value);
    if (number !== null) {
        return { ok: true, reference: { number } };
    }

    try {
        const parsedUrl = new URL(value);
        const parsedNumber = parsePullRequestNumberFromUrl(parsedUrl);
        return {
            ok: true,
            reference: {
                url: parsedUrl.toString(),
                ...(parsedNumber !== null ? { number: parsedNumber } : {}),
            },
        };
    } catch {
        return isSafeHeadBranchReference(value)
            ? { ok: true, reference: { headBranch: value } }
            : { ok: false, error: 'Pull request head branch contains unsupported syntax' };
    }
}
