import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

function normalizeWebPathname(raw: string): string {
  let path = raw;
  if (!path.startsWith('/')) path = `/${path}`;
  for (const suffix of ['/index.html', '/']) {
    if (path.length > 1 && path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length) || '/';
    }
  }
  return path;
}

/**
 * Expo Router can occasionally hydrate the initial route to a less-specific match on web refresh
 * (e.g. `/session/:id` instead of `/session/:id/info`). When that happens, the UI shows the
 * wrong screen while the browser URL remains the deep-link target.
 *
 * This hook reconciles the initial router state with the real browser location exactly once,
 * and only when the browser pathname is a strict extension of the router pathname.
 */
export function useWebInitialRouteReconcile(params: Readonly<{ routerPathname: string }>): void {
  const routerPathnameRef = React.useRef(params.routerPathname);
  const initialHrefRef = React.useRef<string | null>(null);
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    routerPathnameRef.current = params.routerPathname;
  }, [params.routerPathname]);

  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    if (!initialHrefRef.current) {
      initialHrefRef.current = `${window.location.pathname}${window.location.search ?? ''}${window.location.hash ?? ''}`;
    }

    const delaysMs = [0, 50, 200, 1000];
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const attempt = () => {
      if (doneRef.current) return;
      const expectedHref = initialHrefRef.current;
      if (!expectedHref) return;

      const currentHref = `${window.location.pathname}${window.location.search ?? ''}${window.location.hash ?? ''}`;
      // Stop reconciling once the user/app navigates away from the initial page load.
      if (currentHref !== expectedHref) {
        doneRef.current = true;
        return;
      }

      const browserPathname = normalizeWebPathname(window.location.pathname ?? '/');
      const currentPathname = normalizeWebPathname(routerPathnameRef.current ?? '/');
      if (browserPathname === currentPathname) {
        doneRef.current = true;
        return;
      }

      // Only reconcile when the browser path is a strict extension of the current router path.
      if (!browserPathname.startsWith(currentPathname)) return;
      if (browserPathname.length <= currentPathname.length) return;
      if (browserPathname.charAt(currentPathname.length) !== '/') return;

      router.replace(expectedHref as any);
    };

    for (const delay of delaysMs) {
      timers.push(setTimeout(attempt, delay));
    }

    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
}
