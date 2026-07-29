export function resolveRequestPathname(rawUrl: string): string {
    try {
        return new URL(rawUrl, "http://localhost").pathname;
    } catch {
        return rawUrl.split("?", 1)[0] || "/";
    }
}

export function isServerApiPathname(pathname: string): boolean {
    const normalized = pathname.toLowerCase();
    return /^\/v\d+(?:\/|$)/.test(normalized)
        || normalized === "/api"
        || normalized.startsWith("/api/");
}

export function isServerApiRequestPath(rawUrl: string): boolean {
    return isServerApiPathname(resolveRequestPathname(rawUrl));
}
