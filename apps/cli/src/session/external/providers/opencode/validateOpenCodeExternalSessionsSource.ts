import type { ExternalSessionsSource } from '@happier-dev/protocol';

import {
    directSourceValidationError,
    normalizeExternalSessionsUrl,
    type DirectSourceValidationResult,
} from '@/session/external/sourceValidation';

function tryNormalizeExternalSessionsUrl(raw: string): string | null {
    try {
        return normalizeExternalSessionsUrl(raw);
    } catch {
        return null;
    }
}

export function validateOpenCodeExternalSessionsSource(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
}>): DirectSourceValidationResult {
    const { source, env } = params;
    if (source.kind !== 'opencodeServer') return directSourceValidationError('provider/source mismatch');

    const requestedBaseUrlRaw =
        typeof source.baseUrl === 'string' && source.baseUrl.trim().length > 0
            ? source.baseUrl
            : null;
    const requestedBaseUrl = requestedBaseUrlRaw ? tryNormalizeExternalSessionsUrl(requestedBaseUrlRaw) : null;
    if (requestedBaseUrlRaw && !requestedBaseUrl) {
        return directSourceValidationError('invalid source baseUrl');
    }

    const configuredBaseUrlRaw =
        typeof env.HAPPIER_OPENCODE_SERVER_URL === 'string' && env.HAPPIER_OPENCODE_SERVER_URL.trim().length > 0
            ? env.HAPPIER_OPENCODE_SERVER_URL
            : null;
    const configuredBaseUrl = configuredBaseUrlRaw ? tryNormalizeExternalSessionsUrl(configuredBaseUrlRaw) : null;
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
