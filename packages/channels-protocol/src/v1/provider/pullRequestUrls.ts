import type { ConversationProviderDescriptorV1 } from './descriptor.js';

/** Render native PR coordinates using the admitted provider's URL facts. */
export function formatConversationPullRequestUrlV1(provider: Pick<NonNullable<ConversationProviderDescriptorV1['pullRequests']>, 'urlTemplate'>,
    pullRequest: Readonly<{ repository: string; number: number }>): string {
    const repository = pullRequest.repository.split('/').map(encodeURIComponent).join('/');
    return provider.urlTemplate.replace('{repository}', repository).replace('{number}', String(pullRequest.number));
}
