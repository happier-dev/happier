import type { ScmHostingProvider } from '@happier-dev/protocol';

import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from '../remoteUrl';
import type { ScmHostingProviderAdapter, ScmHostingProviderDetectionInput } from '../types';

function hasGithubHostSignal(host: string): boolean {
    return host === 'github.com' || host.startsWith('github.');
}

function hasNeutralScmHostSignal(host: string): boolean {
    return /(^|[.-])(code|scm|git)([.-]|$)/.test(host);
}

function hasGithubPathSignal(pathSegments: readonly string[]): boolean {
    return pathSegments.length === 2;
}

function detectGitHubRemote(input: ScmHostingProviderDetectionInput): ScmHostingProvider | null {
    const parsed = parseScmRemoteUrl(input.remoteUrl);
    if (!parsed) return null;
    const segments = parsed.path.split('/').filter(Boolean);
    if (!hasGithubPathSignal(segments)) return null;
    if (!hasGithubHostSignal(parsed.host) && !hasNeutralScmHostSignal(parsed.host)) return null;
    const baseUrl = `https://${parsed.host}`;
    return {
        kind: 'github',
        name: 'GitHub',
        baseUrl,
        nameWithOwner: segments.join('/'),
        remoteName: input.remoteName,
    };
}

export const githubScmHostingProviderAdapter: ScmHostingProviderAdapter = {
    kind: 'github',
    name: 'GitHub',
    detectRemote: detectGitHubRemote,
    buildCompareUrl(input) {
        const { provider } = input;
        if (provider.kind !== 'github' || !provider.nameWithOwner) return null;
        return `${stripTrailingSlash(provider.baseUrl)}/${provider.nameWithOwner}/compare/${encodeCompareRef(input.base)}...${encodeCompareRef(input.head)}`;
    },
};
