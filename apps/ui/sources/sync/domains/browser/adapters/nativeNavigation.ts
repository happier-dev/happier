export type BrowserNativeNavigationRequest = Readonly<{
    url?: string | null;
}>;

export type BrowserNativeNavigationGuard = (request: BrowserNativeNavigationRequest) => boolean;

export type CreateBrowserNativeNavigationGuardInput = Readonly<{
    allowedOrigins: readonly string[];
    inlineDocument?: boolean;
    onBlockedNavigation?: (url: string) => void;
}>;

export function isBrowserInlineDocumentUrl(url: string): boolean {
    return url === 'about:blank' || url.startsWith('about:blank#');
}

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
        if (input.inlineDocument) {
            if (isBrowserInlineDocumentUrl(url)) return true;
            if (url.length > 0) input.onBlockedNavigation?.(url);
            return false;
        }
        const origin = readOrigin(url);
        if (origin && (allowedOrigins.has(origin) || (
            allowedOrigins.has('*') && (origin.startsWith('https://') || origin.startsWith('http://'))
        ))) {
            return true;
        }
        if (url.length > 0) {
            input.onBlockedNavigation?.(url);
        }
        return false;
    };
}
