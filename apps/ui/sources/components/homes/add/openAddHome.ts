import type { Router } from 'expo-router';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { AddHomePath } from './addHomeFlowModel';

/** One entry decision for Home connection; an already-open welcome keeps its in-pane navigation. */
export function openAddHome(router: Pick<Router, 'push' | 'replace'>, options: Readonly<{
    replace?: boolean;
    address?: string;
    auto?: boolean;
    source?: 'notification';
    path?: AddHomePath;
    onWelcomeHomeStep?: () => void;
}> = {}): void {
    const signedIn = getCurrentAuth()?.isAuthenticated === true;
    if (!signedIn && options.onWelcomeHomeStep) {
        options.onWelcomeHomeStep();
        return;
    }
    const query = new URLSearchParams();
    if (!signedIn) query.set('step', 'home');
    if (options.address) query.set(signedIn ? 'address' : 'server', options.address);
    if (signedIn) {
        if (options.auto) query.set('auto', '1');
        if (options.source) query.set('source', options.source);
        if (options.path) query.set('path', options.path);
    }
    const search = query.toString();
    const href = `${signedIn ? SETTINGS_ROUTES.serversAdd : '/'}${search ? `?${search}` : ''}`;
    if (options.replace) router.replace(href as Parameters<Router['replace']>[0]);
    else router.push(href as Parameters<Router['push']>[0]);
}
