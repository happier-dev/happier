import { describe, expect, it } from 'vitest';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createRootStackRouteOptions, resolveRootStackRouteOptions } from './rootStackRouteOptions';
import { workspaceRouteFiles } from '@/components/appShell/workspace/workspaceRoutes';

installPanelCommonModuleMocks();

describe('root route identity ownership', () => {
    it('distinguishes a root leaf module from a nested navigator index at the same URL', () => {
        const options = createRootStackRouteOptions('auto');
        expect(resolveRootStackRouteOptions(options, workspaceRouteFiles.artifacts)).toMatchObject({ headerShown: false });
        expect(resolveRootStackRouteOptions(options, workspaceRouteFiles.settings)).toBeUndefined();
    });
    it('leaves the dev navigator to own its child chrome, without another outer bar', () => {
        expect(createRootStackRouteOptions('auto')['dev']).toMatchObject({ headerShown: false });
    });
    it('inherits Friends management identity while Add friend stays in its page header', () => {
        const options = createRootStackRouteOptions('auto');
        expect(resolveRootStackRouteOptions(options, workspaceRouteFiles['friends/manage'])).toMatchObject({
            headerShown: true, headerTitle: 'navigation.friends', headerBackTitle: 'common.back',
        });
        expect(options['friends/manage'].headerRight).toBeUndefined();
    });
    it.each(['artifacts/index', 'boards/index'] as const)(
        'leaves %s identity with its always-visible PageHeader', name => {
            expect(createRootStackRouteOptions('auto')[name].headerShown).toBe(false);
        },
    );
    it('retains kind chrome for entity identities and stack identity for pages without their own title', () => {
        const options = createRootStackRouteOptions('auto');
        expect(options['artifacts/[id]']).toMatchObject({ headerShown: true, headerTitle: 'artifacts.title' });
        expect(options['artifacts/new']).toMatchObject({ headerShown: true, headerTitle: 'artifacts.browser.newDocument' });
        expect(options['artifacts/edit/[id]']).toMatchObject({ headerShown: true, headerTitle: 'artifacts.edit' });
        expect(options['workflows/[id]/index']).toMatchObject({ headerShown: true, headerTitle: 'workflows.page.chromeTitle' });
        expect(options['boards/[boardId]']).toMatchObject({ headerShown: true, headerTitle: 'boards.title' });
        expect(options['session/recent']).toMatchObject({ headerShown: true, headerTitle: 'sessionHistory.title' });
        expect(options['workflows/index'].headerShown).toBe(false);
    });
    it('lets the phone Home route show the Atmosphere wallpaper instead of painting an opaque sheet over it', () => {
        expect(createRootStackRouteOptions('auto')['home']).toMatchObject({
            contentStyle: { backgroundColor: 'transparent' }, headerStyle: { backgroundColor: 'transparent' },
            // The picture runs to the top edge, under the Back control, instead of starting below an empty band.
            headerTransparent: true,
        });
    });
    it.each([
        ['automations/index', 'navigation.automations'],
        ['automations/[id]', 'navigation.automation'],
        ['automations/new', 'navigation.newAutomation'],
        ['automations/edit', 'automations.edit.title'],
        ['automations/settings', 'automations.settings.title'],
    ] as const)('declares the central header title for %s', (name, title) => {
        expect(createRootStackRouteOptions('auto')[name]).toMatchObject({ headerShown: true, headerTitle: title });
    });
    it('gives the Store Bots page the Store chrome with its way back on a phone', () => {
        const options = createRootStackRouteOptions('auto');
        const bots = resolveRootStackRouteOptions(options, workspaceRouteFiles['plugins/bots']);
        expect(bots).toBe(options['plugins/index']);
        expect(bots).toMatchObject({ headerShown: true, headerBackTitle: 'common.back' });
    });
    it('hides the shell header on terminal connect', () => {
        expect(createRootStackRouteOptions('auto')['terminal/connect']).toMatchObject({ headerShown: false });
    });
    it('opens settings as a non-animated app-shell destination, never as a modal', () => {
        const settings = createRootStackRouteOptions('auto')['settings'];
        expect(settings).toMatchObject({ headerShown: false, animation: 'none' });
        expect(settings.presentation).toBeUndefined();
        expect(settings.webModalStyle).toBeUndefined();
    });
});
