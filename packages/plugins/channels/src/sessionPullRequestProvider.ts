import type { ConversationProviderDescriptorV1 } from '@happier-dev/channels-protocol/v1';
export { formatConversationPullRequestUrlV1 as sessionPullRequestUrl } from '@happier-dev/channels-protocol/v1';

export type SessionPullRequestProvider = NonNullable<ConversationProviderDescriptorV1['pullRequests']>;

/** Interpret native URL facts from the admitted provider, never a display URL as authority. */
export function parseSessionPullRequestUrl(provider: SessionPullRequestProvider, value: string): Readonly<{ repository: string; number: number }> | null {
    try {
        const url = new URL(value.trim());
        const pattern = provider.urlTemplate.split(/(\{repository\}|\{number\})/u).map(part => part === '{repository}'
            ? '([^/]+/[^/]+)' : part === '{number}' ? '([1-9][0-9]*)' : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('');
        const match = new RegExp(`^${pattern}/?$`, 'u').exec(`${url.origin}${url.pathname}`);
        if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
        return { repository: match[1]!, number: Number(match[2]) };
    } catch { return null; }
}
