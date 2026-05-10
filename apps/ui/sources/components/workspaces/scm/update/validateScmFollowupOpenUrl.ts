import type { ScmFollowupAction } from '@happier-dev/protocol';

export type ScmFollowupOpenUrlValidationResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reason: 'kind' | 'purpose' | 'parse' | 'origin' | 'scheme' | 'path' }>;

function isPathContainedByBase(targetPath: string, basePath: string): boolean {
    const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    if (!normalizedBase || normalizedBase === '/') return true;
    return targetPath === normalizedBase || targetPath.startsWith(`${normalizedBase}/`);
}

export function validateScmFollowupOpenUrl(action: ScmFollowupAction): ScmFollowupOpenUrlValidationResult {
    if (action.kind !== 'openUrl') {
        return { ok: false, reason: 'kind' };
    }
    if (action.purpose !== 'pullRequest' && action.purpose !== 'compose') {
        return { ok: false, reason: 'purpose' };
    }

    let target: URL;
    let allowedBase: URL;
    try {
        target = new URL(action.url);
        allowedBase = new URL(action.allowedBaseUrl);
    } catch {
        return { ok: false, reason: 'parse' };
    }

    const allowedSchemes = action.urlSafety?.allowedSchemes?.length
        ? action.urlSafety.allowedSchemes
        : ['https:'];
    if (!allowedSchemes.includes(target.protocol)) {
        return { ok: false, reason: 'scheme' };
    }
    if (target.origin !== allowedBase.origin) {
        return { ok: false, reason: 'origin' };
    }
    if (!isPathContainedByBase(target.pathname, allowedBase.pathname)) {
        return { ok: false, reason: 'path' };
    }
    return { ok: true, url: target.toString() };
}
