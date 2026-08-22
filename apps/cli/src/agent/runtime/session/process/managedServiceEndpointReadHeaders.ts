import { normalizeProviderPublicHeaders } from '@happier-dev/protocol';

export function serializeManagedServiceEndpointReadRequestHeaders(
    value: ConstructorParameters<typeof Headers>[0],
): Readonly<Record<string, string>> {
    const headers = new Headers(value);
    const result: Record<string, string> = {};
    headers.forEach((headerValue, name) => {
        try {
            normalizeProviderPublicHeaders({ [name]: '' });
        } catch {
            throw new Error(
                'Managed server endpoint read cannot supply authentication',
            );
        }
        if (
            Object.keys(result).length >= 64
            || name.length === 0
            || name.length > 128
            || headerValue.length > 8_192
        ) {
            throw new Error('Managed server endpoint read headers are invalid');
        }
        result[name] = headerValue;
    });
    return Object.freeze(result);
}
