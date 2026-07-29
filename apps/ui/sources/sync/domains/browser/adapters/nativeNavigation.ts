export type BrowserNativeNavigationRequest = Readonly<{
    url?: string | null;
}>;

export type BrowserNativeNavigationGuard = (request: BrowserNativeNavigationRequest) => boolean;

export type CreateBrowserNativeNavigationGuardInput = Readonly<{
    allowedOrigins: readonly string[];
    onBlockedNavigation?: (url: string) => void;
}>;

function readOrigin(rawUrl: string): string | null {
    try {
        return new URL(rawUrl).origin;
    } catch {
        return null;
    }
}

export function createBrowserNativeNavigationGuard(
    input: CreateBrowserNativeNavigationGuardInput,
): BrowserNativeNavigationGuard {
    const allowedOrigins = new Set(input.allowedOrigins);

    return (request) => {
        const url = typeof request.url === 'string' ? request.url : '';
        const origin = readOrigin(url);
        if (origin && allowedOrigins.has(origin)) {
            return true;
        }
        if (url.length > 0) {
            input.onBlockedNavigation?.(url);
        }
        return false;
    };
}
