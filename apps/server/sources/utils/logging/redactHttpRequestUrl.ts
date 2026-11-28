import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol';

export function readOAuthCallbackPath(url: string): string | null {
    const path = url.split('?', 1)[0];
    return /^(?:https?:\/\/[^/]+)?\/v1\/(?:oauth\/[^/]+|supporter\/discord)\/callback\/?$/.test(path) ? path : null;
}

export function redactHttpRequestUrl(url: string): string {
    return readOAuthCallbackPath(url) ?? redactPublicShareCapabilityUrl(url);
}
