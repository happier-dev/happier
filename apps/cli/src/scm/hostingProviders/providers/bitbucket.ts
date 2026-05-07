import type { ScmHostingProvider } from '@happier-dev/protocol';

import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from '../remoteUrl';
import type { ScmHostingProviderAdapter, ScmHostingProviderDetectionInput } from '../types';

function detectBitbucketRemote(input: ScmHostingProviderDetectionInput): ScmHostingProvider | null {
    const parsed = parseScmRemoteUrl(input.remoteUrl);
    if (!parsed || parsed.host !== 'bitbucket.org') return null;
    const segments = parsed.path.split('/').filter(Boolean);
    if (segments.length !== 2) return null;
    return {
        kind: 'bitbucket',
        name: 'Bitbucket',
        baseUrl: 'https://bitbucket.org',
        nameWithOwner: segments.join('/'),
        remoteName: input.remoteName,
    };
}

export const bitbucketScmHostingProviderAdapter: ScmHostingProviderAdapter = {
    kind: 'bitbucket',
    name: 'Bitbucket',
    detectRemote: detectBitbucketRemote,
    buildCompareUrl(input) {
        const { provider } = input;
        if (provider.kind !== 'bitbucket' || !provider.nameWithOwner) return null;
        return `${stripTrailingSlash(provider.baseUrl)}/${provider.nameWithOwner}/branch/${encodeCompareRef(input.head)}?dest=${encodeCompareRef(input.base)}`;
    },
};
