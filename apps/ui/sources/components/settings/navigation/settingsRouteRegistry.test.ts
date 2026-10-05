import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    getSettingsStackScreenDefinitions,
    listSettingsRouteNames,
    resolveSettingsNestedRouteName,
    resolveSettingsRouteParentPathname,
    resolveSettingsRouteTitleKey,
} from './settingsRouteRegistry';

/** Every settings screen file (`app/(app)/settings/**`), as a route name such as `prompts/skills/[id]/files/edit`. */
function listSettingsRouteFiles(): string[] {
    const root = join(__dirname, '..', '..', '..', 'app', '(app)', 'settings');
    const out: string[] = [];
    const visit = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                visit(path);
                continue;
            }
            if (!entry.endsWith('.tsx') || entry.startsWith('_') || /\.(test|spec)\./.test(entry)) continue;
            out.push(relative(root, path).replace(/\\/g, '/').replace(/\.tsx$/, ''));
        }
    };
    visit(root);
    return out.sort();
}

/** The URL path a route name renders at (`index` is its directory), as a list of pattern segments. */
function routePatternSegments(name: string): string[] {
    const segments = name.split('/');
    return segments[segments.length - 1] === 'index' ? segments.slice(0, -1) : segments;
}

function matchesPattern(pattern: readonly string[], segments: readonly string[]): boolean {
    return pattern.length === segments.length
        && pattern.every((part, index) => (part.startsWith('[') && part.endsWith(']')) || part === segments[index]);
}

const translate = (key: string) => key;

describe('settingsRouteRegistry', () => {
    it('adds deterministic parent navigation to settings subroute headers', () => {
        const definitions = getSettingsStackScreenDefinitions(translate as never);
        const indexRoute = definitions.find((definition) => definition.name === 'index');
        const sessionRoute = definitions.find((definition) => definition.name === 'session');

        expect(indexRoute?.options.headerLeft).toBeUndefined();
        expect(typeof sessionRoute?.options.headerLeft).toBe('function');
    });

    it('resolves route parent paths from the current settings pathname', () => {
        expect(resolveSettingsRouteParentPathname('/settings')).toBeNull();
        expect(resolveSettingsRouteParentPathname('/settings/session')).toBe('/settings');
        // A saved custom ACP agent sits in the Agents collection, not under the new-agent draft.
        expect(resolveSettingsRouteParentPathname('/settings/agents/custom/kiro')).toBe('/settings/agents');
        expect(resolveSettingsRouteParentPathname('/settings/agents/custom')).toBe('/settings/agents');
        expect(resolveSettingsRouteParentPathname('/settings/session/transcript/advanced')).toBe('/settings/session/transcript');
        expect(resolveSettingsRouteParentPathname('/settings/prompts/docs/doc%2F1/export')).toBe('/settings/prompts/docs/doc%2F1');
        expect(resolveSettingsRouteParentPathname('/settings/plugins/examples.descriptor-only/settings')).toBe('/settings/plugins/examples.descriptor-only');
        expect(resolveSettingsRouteParentPathname('/session/s1')).toBeNull();
    });

    it('skips non-route identity collection segments when navigating Home administration', () => {
        // Identity providers and GitHub Apps belong to the Sign-in providers page, so back lands there.
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/sign-in-providers/identity/new'))
            .toBe('/settings/home/home-1/sign-in-providers');
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/sign-in-providers/identity/provider-1'))
            .toBe('/settings/home/home-1/sign-in-providers');
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/sign-in-providers/github-apps/new'))
            .toBe('/settings/home/home-1/sign-in-providers');
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/sign-in-providers/github-apps/registration-1'))
            .toBe('/settings/home/home-1/sign-in-providers');
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/sign-in-providers/identity/provider-1/edit'))
            .toBe('/settings/home/home-1/sign-in-providers/identity/provider-1');
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/sign-in-providers'))
            .toBe('/settings/home/home-1');
    });

    it('resolves every Home console page in the console collection, whose navigator root has a dynamic segment', () => {
        expect(resolveSettingsNestedRouteName('home/[serverId]', '/settings/home/home-1')).toBe('index');
        expect(resolveSettingsNestedRouteName('home/[serverId]', '/settings/home/home-1/reach')).toBe('reach');
        expect(resolveSettingsNestedRouteName('home/[serverId]', '/settings/home/home-1/people')).toBe('people/index');
        expect(resolveSettingsNestedRouteName('home/[serverId]', '/settings/home/home-1/people/account-1')).toBe('people/[accountId]');
        expect(resolveSettingsNestedRouteName('home/[serverId]', '/settings/home/home-1/sign-in-providers/identity/provider-1'))
            .toBe('sign-in-providers/identity/[providerId]/index');
        expect(resolveSettingsNestedRouteName('home/[serverId]', '/settings/home')).toBeNull();
        // A person's page goes back to the People list of the same Home.
        expect(resolveSettingsRouteParentPathname('/settings/home/home-1/people/account-1')).toBe('/settings/home/home-1/people');
    });

    it('returns from a skill file editor to its skill, since `files` has no page of its own', () => {
        expect(resolveSettingsRouteParentPathname('/settings/prompts/skills/skill-1/files/edit')).toBe('/settings/prompts/skills/skill-1');
        expect(resolveSettingsRouteParentPathname('/settings/prompts/skills/skill-1/files/new')).toBe('/settings/prompts/skills/skill-1');
    });

    it('registers every settings screen file, so the registry can say which routes are mounted', () => {
        const registered = new Set(listSettingsRouteNames());
        expect(listSettingsRouteFiles().filter((file) => !registered.has(file))).toEqual([]);
    });

    it('sends every settings screen with a back affordance to a mounted parent route', () => {
        const files = listSettingsRouteFiles();
        const mounted = files.map(routePatternSegments);
        const unmountedParents: string[] = [];
        for (const file of files) {
            const pattern = routePatternSegments(file);
            if (pattern.length === 0) continue;
            // A concrete pathname for the route: each dynamic segment gets a sample value.
            const pathname = `/settings/${pattern.map((part) => (part.startsWith('[') ? `x-${part.slice(1, -1)}` : part)).join('/')}`;
            const parent = resolveSettingsRouteParentPathname(pathname);
            if (parent === null) {
                unmountedParents.push(`${file} → (none)`);
                continue;
            }
            const parentSegments = parent === '/settings' ? [] : parent.slice('/settings/'.length).split('/');
            if (!mounted.some((candidate) => matchesPattern(candidate, parentSegments))) {
                unmountedParents.push(`${file} → ${parent}`);
            }
        }
        expect(unmountedParents).toEqual([]);
    });

    it('returns from a Team to the Teams collection, since a Home segment has no page of its own', () => {
        expect(resolveSettingsRouteParentPathname('/settings/teams/home-1/team-1')).toBe('/settings/teams');
        expect(resolveSettingsRouteParentPathname('/settings/teams/home-1/team-1/members'))
            .toBe('/settings/teams/home-1/team-1');
        expect(resolveSettingsRouteParentPathname('/settings/teams/new')).toBe('/settings/teams');
    });

    it('skips the non-route GitHub Apps collection when navigating Team authentication', () => {
        expect(resolveSettingsRouteParentPathname(
            '/settings/teams/home-1/team-1/authentication/github-apps/registration-1',
        )).toBe('/settings/teams/home-1/team-1/authentication');

        expect(resolveSettingsRouteParentPathname(
            '/settings/teams/home-1/team-1/authentication/github-apps/registration-1/edit',
        )).toBe('/settings/teams/home-1/team-1/authentication/github-apps/registration-1');
    });

    it('registers model-management and plugin-settings routes', () => {
        const names = getSettingsStackScreenDefinitions(translate as never).map((definition) => definition.name);
        expect(names).toContain('providers');
        expect(names).not.toContain('providers/[connectionId]/models');
        expect(names).toContain('agents');
        expect(names).not.toContain('agents/[agentId]/models');
        expect(names).toContain('plugins/webhooks');
        expect(names).toContain('plugins/[pluginId]/[pageId]');
    });

    it('keeps Provider detail headers and parent navigation in its nested navigator', () => {
        const root = getSettingsStackScreenDefinitions(translate as never);
        expect(root.find((definition) => definition.name === 'providers')?.options.headerTitle).toBe('settingsProviders.title');
        const providers = getSettingsStackScreenDefinitions(translate as never, { navigator: 'providers' });
        expect(providers.map((definition) => definition.name)).toEqual([
            'index', '[connectionId]', '[connectionId]/models', 'new',
        ]);
        const models = providers.find((definition) => definition.name === '[connectionId]/models');
        expect(models?.options.headerTitle).toBe('settingsProviders.models.manage');
        expect(typeof models?.options.headerLeft).toBe('function');
        expect(getSettingsStackScreenDefinitions(translate as never, { navigator: 'providers', isModalPresentation: true })
            .every((definition) => definition.options.headerShown === false)).toBe(true);
    });

    it('keeps Agent detail headers and parent navigation in its nested navigator', () => {
        const agents = getSettingsStackScreenDefinitions(translate as never, { navigator: 'agents' });
        expect(agents.map((definition) => definition.name)).toEqual(['index', '[agentId]', '[agentId]/models', 'custom/index', 'custom/[backendId]']);
        const models = agents.find((definition) => definition.name === '[agentId]/models');
        expect(models?.options.headerTitle).toBe('settingsAgents.models');
        expect(typeof models?.options.headerLeft).toBe('function');
    });

    it('registers the marketplace sources route with its section chrome title', () => {
        const sourcesRoute = getSettingsStackScreenDefinitions(translate as never)
            .find((definition) => definition.name === 'plugins/sources');

        expect(sourcesRoute).toBeDefined();
        expect(sourcesRoute?.options.headerTitle).toBe('settingsPlugins.sourceAdministration.title');
    });

    it('keeps the Machines collection, its machine detail, setup and pool editors in one nested navigator', () => {
        const machines = getSettingsStackScreenDefinitions(translate as never, { navigator: 'machines' });
        expect(machines.map((definition) => definition.name)).toEqual([
            'index', '[id]', 'add', 'this-computer', 'pools/[poolId]', 'pools/new',
        ]);
        expect(machines.find((definition) => definition.name === 'pools/new')?.options.headerTitle).toBe('machinePools.add');
        expect(machines.find((definition) => definition.name === 'pools/[poolId]')?.options.headerTitle).toBe('machinePools.title');
        const root = getSettingsStackScreenDefinitions(translate as never).map((definition) => definition.name);
        expect(root).toContain('machines');
        expect(root.filter((name) => name.startsWith('machines/'))).toEqual([]);

        expect(resolveSettingsRouteTitleKey('/settings/machines/pools/new')).toBe('machinePools.add');
        expect(resolveSettingsRouteTitleKey('/settings/machines/this-computer')).toBe('settingsMachines.thisComputerTitle');
        expect(resolveSettingsRouteTitleKey('/settings/machines/machine-1')).toBe('settings.machines');
        // Everything in the collection goes back to the collection; `pools` is not a page of its own.
        expect(resolveSettingsRouteParentPathname('/settings/machines/pools/pool-1')).toBe('/settings/machines');
        expect(resolveSettingsRouteParentPathname('/settings/machines/pools/new')).toBe('/settings/machines');
        expect(resolveSettingsRouteParentPathname('/settings/machines/machine-1')).toBe('/settings/machines');
    });

    it('titles the Homes page with the label the settings catalog and sidebar use', () => {
        expect(resolveSettingsRouteTitleKey('/settings/server')).toBe('settings.servers');
    });

    it('registers every Home administration destination in the Home console navigator, beside the console rail', () => {
        const rootNames = getSettingsStackScreenDefinitions(translate as never).map((definition) => definition.name);
        expect(rootNames).toEqual(expect.arrayContaining(['home/index', 'home/[serverId]']));
        expect(rootNames.filter((name) => name.startsWith('home/[serverId]/'))).toEqual([]);

        const consolePages = getSettingsStackScreenDefinitions(translate as never, { navigator: 'home/[serverId]' })
            .map((definition) => definition.name);
        expect(consolePages).toEqual(expect.arrayContaining([
            'index',
            'people/index',
            'people/[accountId]',
            'policies',
            'teams',
            'reach',
            'email',
            'features',
            'data',
            'runtime',
            'server-settings',
            'activity',
            'policies/identity/new',
            'policies/identity/[providerId]/index',
            'policies/identity/[providerId]/edit',
            'policies/github-apps/new',
            'policies/github-apps/[registrationId]/index',
            'policies/github-apps/[registrationId]/edit',
            'sign-in-providers',
            'sign-in-providers/identity/new',
            'sign-in-providers/identity/[providerId]/index',
            'sign-in-providers/identity/[providerId]/edit',
            'sign-in-providers/github-apps/new',
            'sign-in-providers/github-apps/[registrationId]/index',
            'sign-in-providers/github-apps/[registrationId]/edit',
        ]));
    });

    it('keeps every Team destination in the Teams collection navigator', () => {
        const root = getSettingsStackScreenDefinitions(translate as never);
        const rootNames = root.map((definition) => definition.name);
        expect(root.find((definition) => definition.name === 'teams')?.options.headerTitle).toBe('teams.title');
        expect(rootNames.some((name) => name.startsWith('teams/'))).toBe(false);

        const teams = getSettingsStackScreenDefinitions(translate as never, { navigator: 'teams' });
        expect(teams.map((definition) => definition.name)).toEqual(expect.arrayContaining([
            'index',
            'new',
            '[serverId]/[teamId]/index',
            '[serverId]/[teamId]/members/index',
            '[serverId]/[teamId]/members/add',
            '[serverId]/[teamId]/members/[membershipId]',
            '[serverId]/[teamId]/groups/index',
            '[serverId]/[teamId]/groups/new',
            '[serverId]/[teamId]/groups/[groupId]',
            '[serverId]/[teamId]/invitations/index',
            '[serverId]/[teamId]/invitations/new',
            '[serverId]/[teamId]/settings',
            '[serverId]/[teamId]/authentication',
            '[serverId]/[teamId]/authentication/new',
            '[serverId]/[teamId]/authentication/[connectionId]',
            '[serverId]/[teamId]/authentication/[connectionId]/edit',
            '[serverId]/[teamId]/authentication/directory',
            '[serverId]/[teamId]/authentication/directory/[sourceId]',
            '[serverId]/[teamId]/authentication/github-apps/[registrationId]/index',
            '[serverId]/[teamId]/authentication/github-apps/[registrationId]/edit',
            '[serverId]/[teamId]/credentials/index',
            '[serverId]/[teamId]/credentials/[resourceId]/usage',
        ]));
        const members = teams.find((definition) => definition.name === '[serverId]/[teamId]/members/index');
        expect(members?.options.headerTitle).toBe('teams.tabs.members');
        expect(typeof members?.options.headerLeft).toBe('function');
    });

    it('registers each Voice intent as a nested settings destination', () => {
        const names = getSettingsStackScreenDefinitions(translate as never).map((definition) => definition.name);

        expect(names).toEqual(expect.arrayContaining([
            'voice/dictation',
            'voice/conversations',
            'voice/privacy',
            'voice/advanced',
        ]));
    });
});

describe('resolveSettingsNestedRouteName', () => {
    it('names the nested screen a collection pathname renders, preferring a static segment', async () => {
        const { resolveSettingsNestedRouteName } = await import('./settingsRouteRegistry');
        expect(resolveSettingsNestedRouteName('teams', '/settings/teams')).toBe('index');
        expect(resolveSettingsNestedRouteName('teams', '/settings/teams/new')).toBe('new');
        expect(resolveSettingsNestedRouteName('teams', '/settings/teams/home-a/team-1')).toBe('[serverId]/[teamId]/index');
        expect(resolveSettingsNestedRouteName('teams', '/settings/teams/home-a/team-1/members/add/'))
            .toBe('[serverId]/[teamId]/members/add');
        expect(resolveSettingsNestedRouteName('teams', '/settings/teams/home-a/team-1/members/m-1'))
            .toBe('[serverId]/[teamId]/members/[membershipId]');
        expect(resolveSettingsNestedRouteName('teams', '/settings/teams/home-a/team-1/authentication/directory'))
            .toBe('[serverId]/[teamId]/authentication/directory');
        expect(resolveSettingsNestedRouteName('teams', '/settings/agents')).toBeNull();
    });
});

describe('resolveSettingsRouteTitleKey', () => {
    it('resolves the page title a configuration page header shows, from the same registry the native header uses', async () => {
        const { resolveSettingsRouteTitleKey } = await import('./settingsRouteRegistry');
        expect(resolveSettingsRouteTitleKey('/settings')).toBe('settings.title');
        expect(resolveSettingsRouteTitleKey('/settings/appearance')).toBe('settings.appearance');
        expect(resolveSettingsRouteTitleKey('/settings/agents')).toBe('settingsAgents.title');
        expect(resolveSettingsRouteTitleKey('/settings/agents/claude/models')).toBe('settingsAgents.models');
        // A static segment wins over a dynamic sibling (`prompts/docs/new` vs `prompts/docs/[id]`).
        expect(resolveSettingsRouteTitleKey('/settings/prompts/docs/new')).toBe('promptLibrary.newPrompt');
        expect(resolveSettingsRouteTitleKey('/settings/prompts/docs/abc')).toBe('promptLibrary.editPrompt');
        // The Providers stack is a nested navigator; its screens resolve under `/settings/providers`.
        expect(resolveSettingsRouteTitleKey('/settings/providers/conn-1')).toBe('settingsProviders.detailTitle');
        // So is the Teams collection.
        expect(resolveSettingsRouteTitleKey('/settings/teams')).toBe('teams.title');
        expect(resolveSettingsRouteTitleKey('/settings/teams/home-a/team-1/members')).toBe('teams.tabs.members');
        expect(resolveSettingsRouteTitleKey('/settings/teams/new')).toBe('teams.create.title');
        expect(resolveSettingsRouteTitleKey('/settings/nope/nothing')).toBeNull();
    });
});
