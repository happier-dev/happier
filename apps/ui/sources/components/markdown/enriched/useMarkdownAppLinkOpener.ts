import * as React from 'react';
import { useWorkspaceRouterFacts } from '@/components/appShell/workspace/WorkspaceNavigationContext';

/** Route admission and placement stay with the current shell, including the phone stack. */
export function useMarkdownAppLinkOpener(): (href: string) => boolean {
    const workspace = useWorkspaceRouterFacts();
    return React.useCallback((href: string) => {
        const navigation = workspace?.read();
        if (navigation?.phone) return navigation.phone.openHref(href, 'newTab');
        return navigation?.openHref(href) ?? false;
    }, [workspace]);
}
