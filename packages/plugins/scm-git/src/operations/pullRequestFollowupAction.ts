import type {
  ScmFollowupAction,
  ScmHostingProviderRef,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { resolveScmHostingProviderFollowupAllowedBaseUrl } from '@happier-dev/plugin-sdk/experimental/scm';

export function createValidatedPullRequestFollowupAction(_input: Readonly<{
    provider: ScmHostingProviderRef;
    purpose: 'pullRequest' | 'compose';
    url: string;
    allowedBaseUrl: string;
}>): ScmFollowupAction {
    const input = _input;
    const allowedBaseUrl = resolveScmHostingProviderFollowupAllowedBaseUrl({
        provider: input.provider,
        allowedBaseUrl: input.allowedBaseUrl,
    });
    if (!allowedBaseUrl) {
        return { kind: 'none' };
    }

    let target: URL;
    let base: URL;
    try {
        target = new URL(input.url);
        base = new URL(allowedBaseUrl);
    } catch {
        return { kind: 'none' };
    }
    if (target.username || target.password || base.username || base.password) {
        return { kind: 'none' };
    }

    const allowedSchemes = input.provider.urlSafety?.allowedSchemes?.length
        ? input.provider.urlSafety.allowedSchemes
        : ['https:'];
    if (!allowedSchemes.includes(target.protocol)) {
        return { kind: 'none' };
    }
    if (target.origin !== base.origin) {
        return { kind: 'none' };
    }

    const basePath = base.pathname.replace(/\/+$/, '');
    if (basePath && basePath !== '/' && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
        return { kind: 'none' };
    }

    return {
        kind: 'openUrl',
        purpose: input.purpose,
        url: target.toString(),
        allowedBaseUrl: base.toString().replace(/\/$/, ''),
        urlSafety: { allowedSchemes: [...allowedSchemes] },
    };
}
