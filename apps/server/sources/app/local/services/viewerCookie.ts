import { isLocalServicePreviewLocalhostHostname, readLocalServiceRequestHostname, resolveLocalServiceExternalProtocol } from './preview/origin';

/**
 * Admitted preview origins keep host-only cookies scoped to their top-level viewer site.
 * WebKit rejects Secure cookies on HTTP localhost. An explicit top-level document
 * there uses Lax; embedded/unknown contexts retain the cross-site partitioned cookie.
 * Fetch Metadata chooses delivery attributes only, never preview authorization.
 */
export function scopedLocalServiceViewerTokenCookie(input: Readonly<{
    name: 'happier_preview_token' | 'happier_public_token';
    path: string;
    value: string;
    request?: Readonly<{ protocol?: string; headers?: Record<string, unknown> }>;
    externalProtocol?: 'http' | 'https';
}>): string {
    const localHttpDocument = input.request?.protocol === 'http'
        && input.request.headers?.['sec-fetch-dest'] === 'document'
        && resolveLocalServiceExternalProtocol({ requestIsSecure: false, configured: input.externalProtocol }) === 'http'
        && isLocalServicePreviewLocalhostHostname(readLocalServiceRequestHostname(input.request.headers) ?? '');
    return [
        `${input.name}=${encodeURIComponent(input.value)}`,
        `Path=${input.path}`,
        'HttpOnly',
        ...(localHttpDocument ? ['SameSite=Lax'] : [
            // Preview frames can be cross-site relative to the app. Lax rejects their
            // exchange cookie; partitioning confines it to the embedding site's jar.
            'SameSite=None',
            'Secure',
            'Partitioned',
        ]),
    ].join('; ');
}
