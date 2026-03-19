type RouterLike = Readonly<{
    back: () => void;
    replace: (href: string) => void;
    canGoBack?: () => boolean;
}>;

type NavigationLike = Readonly<{
    canGoBack?: () => boolean;
}>;

export function safeRouterBack(params: { router: RouterLike; navigation?: NavigationLike | null; fallbackHref: string }): void {
    const canGoBack =
        typeof params.navigation?.canGoBack === 'function'
            ? params.navigation.canGoBack()
            : typeof params.router.canGoBack === 'function'
                ? params.router.canGoBack()
            : true;

    if (!canGoBack) {
        params.router.replace(params.fallbackHref);
        return;
    }

    try {
        params.router.back();
    } catch {
        params.router.replace(params.fallbackHref);
    }
}
