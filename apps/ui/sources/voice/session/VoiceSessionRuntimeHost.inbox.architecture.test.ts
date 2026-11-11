import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Voice runtime Inbox owner', () => {
    it('mounts the canonical Inbox owner for the active Voice lifetime', async () => {
        const source = await readFile(new URL('./VoiceSessionRuntimeHost.tsx', import.meta.url), 'utf8');

        expect(source).toContain("import { InboxModelProvider } from '@/hooks/inbox/useInboxModel';");
        expect(source).toContain('<InboxModelProvider>');
    });

    it('mounts Activity membership above the route and Voice runtime together', async () => {
        const rootLayout = await readFile(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
        const sidebar = await readFile(new URL('../../components/navigation/shell/SidebarNavigator.tsx', import.meta.url), 'utf8');

        expect(rootLayout).toContain("import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';");
        expect(rootLayout).toContain('const realtimeRouteContent = primaryRealm ? <RealtimeProvider>{routeNavigation}</RealtimeProvider> : routeNavigation;');
        expect(rootLayout).toMatch(/const routeContent = desktopWindowContext.chrome === 'destination'\s*\? realtimeRouteContent\s*: <AppActivityOwner>\{realtimeRouteContent\}<\/AppActivityOwner>/);
        expect(rootLayout).toContain('<ActivityPersonalSessionMembershipProvider enabled={isAuthenticated}>');
        expect(sidebar).not.toContain('<ActivityPersonalSessionMembershipProvider enabled={isAuthenticated}>');
    });
});
