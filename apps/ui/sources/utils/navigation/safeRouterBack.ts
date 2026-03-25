type RouterLike = Readonly<{
    back: () => void;
    replace: (href: string) => void;
    canGoBack?: () => boolean;
}>;

type NavigationLike = Readonly<{
    canGoBack?: () => boolean;
}>;

export function safeRouterBack(params: { router: RouterLike; navigation?: NavigationLike | null; fallbackHref: string }): void {
    const routerCanGoBack = typeof params.router.canGoBack === 'function'
        ? params.router.canGoBack()
        : null;
    const navigationCanGoBack = typeof params.navigation?.canGoBack === 'function'
        ? params.navigation.canGoBack()
        : null;

    const canGoBack = routerCanGoBack === false || navigationCanGoBack === false
        ? false
        : routerCanGoBack ?? navigationCanGoBack ?? true;

    if (!canGoBack) {
        params.router.replace(params.fallbackHref);
        return;
    }

    try {
        const startHref = typeof (globalThis as any)?.location?.href === 'string'
            ? String((globalThis as any).location.href)
            : null;
        const historyBack = typeof (globalThis as any)?.history?.back === 'function'
            ? (globalThis as any).history.back.bind((globalThis as any).history)
            : null;
        if (historyBack) {
            historyBack();
        } else {
            params.router.back();
        }

        // On web, Expo Router can sometimes no-op `router.back()` without throwing.
        // If the URL doesn't change shortly after, fall back to a deterministic replace.
        if (startHref) {
            setTimeout(() => {
                const currentHref = typeof (globalThis as any)?.location?.href === 'string'
                    ? String((globalThis as any).location.href)
                    : null;
                if (currentHref && currentHref === startHref) {
                    params.router.replace(params.fallbackHref);
                }
            }, 50);
        }
    } catch {
        params.router.replace(params.fallbackHref);
    }
}
