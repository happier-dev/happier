export const LOCAL_SERVICE_PUBLIC_TOKEN_COOKIE_NAME = "happier_public_token";

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readLocalServicePublicTokenCookie(headers: Record<string, unknown> | undefined): string | null {
    const cookieHeader = headers?.cookie;
    if (typeof cookieHeader !== "string") return null;
    for (const entry of cookieHeader.split(";")) {
        const [rawName, ...rawValue] = entry.trim().split("=");
        if (rawName === LOCAL_SERVICE_PUBLIC_TOKEN_COOKIE_NAME) {
            const value = rawValue.join("=").trim();
            if (value.length === 0) return null;
            try {
                return decodeURIComponent(value);
            } catch {
                return null;
            }
        }
    }
    return null;
}

export function scopedLocalServicePublicTokenCookie(input: Readonly<{
    path: string;
    rawToken: string;
    secure: boolean;
}>): string {
    return [
        `${LOCAL_SERVICE_PUBLIC_TOKEN_COOKIE_NAME}=${encodeURIComponent(input.rawToken)}`,
        `Path=${input.path}`,
        "HttpOnly",
        "SameSite=Lax",
        input.secure ? "Secure" : null,
    ].filter((part): part is string => Boolean(part)).join("; ");
}

export function localServicePublicTokenCookiePath(exposureId: string): string {
    return `/v1/local-services/public/${encodeURIComponent(exposureId)}`;
}

export function readLocalServicePublicQueryToken(query: Record<string, unknown> | undefined): string | null {
    return readString(query?.publicToken);
}
