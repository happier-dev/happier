const BASE64_ENCODE_CHUNK_SIZE = 0x8000;

export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    let normalizedBase64 = base64;
    
    if (encoding === 'base64url') {
        normalizedBase64 = base64
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        
        const padding = normalizedBase64.length % 4;
        if (padding) {
            normalizedBase64 += '='.repeat(4 - padding);
        }
    }
    
    const binaryString = atob(normalizedBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes;
}

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    // Avoid call-stack overflows on large payloads (e.g. SCM snapshots).
    // Use chunk array + join to keep memory growth linear for multi-MB payloads.
    const chunks: string[] = [];
    for (let i = 0; i < buffer.length; i += BASE64_ENCODE_CHUNK_SIZE) {
        const chunk = buffer.subarray(i, i + BASE64_ENCODE_CHUNK_SIZE);
        chunks.push(String.fromCharCode(...chunk));
    }
    const binaryString = chunks.join('');
    const base64 = btoa(binaryString);
    
    if (encoding === 'base64url') {
        return base64
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }
    
    return base64;
}
