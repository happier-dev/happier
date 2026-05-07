import type { ScmHostingProvider } from '@happier-dev/protocol';

import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from '../remoteUrl';
import type { ScmHostingProviderAdapter, ScmHostingProviderDetectionInput } from '../types';

function hasGitlabHostSignal(host: string): boolean {
    return /(^|[.])gitlab([.-]|$)/.test(host);
}

function hasGitlabPathSignal(pathSegments: readonly string[]): boolean {
    return pathSegments.length >= 3;
}

function detectGitLabRemote(input: ScmHostingProviderDetectionInput): ScmHostingProvider | null {
    const parsed = parseScmRemoteUrl(input.remoteUrl);
    if (!parsed) return null;
    const segments = parsed.path.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    if (!hasGitlabHostSignal(parsed.host) && !hasGitlabPathSignal(segments)) return null;
    return {
        kind: 'gitlab',
        name: 'GitLab',
        baseUrl: `https://${parsed.host}`,
        nameWithOwner: segments.join('/'),
        remoteName: input.remoteName,
    };
}

export const gitlabScmHostingProviderAdapter: ScmHostingProviderAdapter = {
    kind: 'gitlab',
    name: 'GitLab',
    detectRemote: detectGitLabRemote,
    buildCompareUrl(input) {
        const { provider } = input;
        if (provider.kind !== 'gitlab' || !provider.nameWithOwner) return null;
        return `${stripTrailingSlash(provider.baseUrl)}/${provider.nameWithOwner}/-/compare/${encodeCompareRef(input.base)}...${encodeCompareRef(input.head)}`;
    },
};
