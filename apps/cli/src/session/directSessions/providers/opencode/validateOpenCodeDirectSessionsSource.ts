import type { DirectSessionsSource } from '@happier-dev/protocol';

import {
    directSourceValidationError,
    normalizeDirectSessionsUrl,
    type DirectSourceValidationResult,
} from '@/session/directSessions/sourceValidation';

function tryNormalizeDirectSessionsUrl(raw: string): string | null {
    try {
        return normalizeDirectSessionsUrl(raw);
    } catch {
        return null;
    }
}

export function validateOpenCodeDirectSessionsSource(params: Readonly<{
    source: DirectSessionsSource;
    env: NodeJS.ProcessEnv;
}>): DirectSourceValidationResult {
    const { source, env } = params;
    if (source.kind !== 'opencodeServer') return directSourceValidationError('provider/source mismatch');

    const requestedBaseUrlRaw =
        typeof source.baseUrl === 'string' && source.baseUrl.trim().length > 0
            ? source.baseUrl
            : null;
    const requestedBaseUrl = requestedBaseUrlRaw ? tryNormalizeDirectSessionsUrl(requestedBaseUrlRaw) : null;
    if (requestedBaseUrlRaw && !requestedBaseUrl) {
        return directSourceValidationError('invalid source baseUrl');
    }

    const configuredBaseUrlRaw =
        typeof env.HAPPIER_OPENCODE_SERVER_URL === 'string' && env.HAPPIER_OPENCODE_SERVER_URL.trim().length > 0
            ? env.HAPPIER_OPENCODE_SERVER_URL
            : null;
    const configuredBaseUrl = configuredBaseUrlRaw ? tryNormalizeDirectSessionsUrl(configuredBaseUrlRaw) : null;
    if (configuredBaseUrlRaw && !configuredBaseUrl) {
        return directSourceValidationError('invalid configured baseUrl');
    }

    if (requestedBaseUrl && !configuredBaseUrl) {
        return directSourceValidationError('source baseUrl override is not allowed');
    }
    if (requestedBaseUrl && configuredBaseUrl && requestedBaseUrl !== configuredBaseUrl) {
        return directSourceValidationError('source baseUrl override is not allowed');
    }

    return {
        ok: true,
        source: configuredBaseUrl
            ? {
                ...source,
                baseUrl: configuredBaseUrl,
            }
            : source,
    };
}
