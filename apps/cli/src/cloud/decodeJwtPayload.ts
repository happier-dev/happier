/**
 * Utility functions for connect commands
 */

/**
 * Decode JWT payload without verification
 * Used to extract user info (email) from id_token
 * 
 * @param token - JWT token string
 * @returns Decoded payload or null if invalid
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            return null;
        }
        
        // JWT payload is the second part, base64url encoded
        const payload = parts[1];
        
        // Decode base64url to JSON
        const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * The account id a Happier credential token names: its trimmed `sub`, or null
 * when the token is malformed or carries no subject. The one reader for it.
 */
export function readAccountIdFromToken(token: string): string | null {
    const subject = decodeJwtPayload(token)?.sub;
    return typeof subject === 'string' && subject.trim() ? subject.trim() : null;
}

/**
 * The Account credential epoch a Happier credential token carries (`tokenEpoch`,
 * top-level or in `extras`; absent reads as 0 like the server's legacy rule), or
 * null when the token is malformed. Non-secret: the server bumps it to retire
 * every earlier credential of the Account. Never proof of authority by itself.
 */
export function readCredentialEpochFromToken(token: string): number | null {
    const payload = decodeJwtPayload(token);
    if (!payload) return null;
    const extras = payload.extras && typeof payload.extras === 'object' && !Array.isArray(payload.extras)
        ? payload.extras as Record<string, unknown> : {};
    const raw = payload.tokenEpoch ?? extras.tokenEpoch ?? 0;
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}
