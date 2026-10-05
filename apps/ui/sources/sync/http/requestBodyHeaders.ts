/** Bodyless requests must not trigger the server's JSON body parser. */
export function normalizeRequestBodyHeaders(headers: Headers, body: RequestInit['body']): void {
    if (body !== undefined && body !== null && body !== '') return;
    const mediaType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType === 'application/json' || (mediaType && /^[^/]+\/[^/]+\+json$/.test(mediaType))) {
        headers.delete('content-type');
    }
}
