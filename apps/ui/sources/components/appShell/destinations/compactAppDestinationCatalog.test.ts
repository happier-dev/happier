import * as React from 'react';
import { BotsRosterRuntimeProvider, useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { createSessionScmPullRequestDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { resolveHref } from 'expo-router/build/link/href';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';
import { readPluginSettingsPageRouteParams } from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';

import {
    resolveCompactAppDestinations,
    resolveCurrentAppDestination,
    resolveDestinationRefFromHref,
    hrefForDestinationRef,
    readDestinationInstanceTitle,
    useActivateAppDestination,
    useCompactAppDestinations,
    selectAppDestinationsInPlacement,
} from './compactAppDestinationCatalog';

// Catalog/navigation contracts never access the Session-envelope HTTP API.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Session-envelope HTTP API is outside this catalog test'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

// No Markdown is rendered here; preserve the external SDK boundary if reached.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown SDK is outside this catalog test'); },
}));

// Device preference storage is the boundary; catalog and placement owners remain real.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock, createUseLocalSettingMutableMock } = await import('@/dev/testkit/mocks/storage');
    const useLocalSetting = createUseLocalSettingMock({ values: {
        navigationSurfacePlacementsV1: { appRail: { orderedIds: ['settings', 'sessions'], placements: { sessions: 'hidden', personalize: 'pinned' } } },
    } });
    return createStorageModuleStub({ useLocalSetting, useLocalSettingMutable: createUseLocalSettingMutableMock(useLocalSetting) });
});

describe('workspace route identity round trips', () => {
    it('includes hidden contribution defaults for rail customization only', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const accountPlacement = { kind: 'rail', region: 'account' } as const;
        expect(selectAppDestinationsInPlacement(catalog, accountPlacement).map(destination => destination.id)).not.toContain('personalize');
        expect(selectAppDestinationsInPlacement(catalog, accountPlacement, { includeHidden: true }).map(destination => destination.id)).toContain('personalize');
    });
    it('names hidden Personalize tabs at every visited step while unknown destinations remain unavailable', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const personalize = catalog.find(destination => destination.id === 'personalize')!;
        expect(personalize.visibility).toBe('hidden');
        const visits: readonly Readonly<Record<string, string>>[] = [{}, { page: 'conversation' }, { page: 'notifications', anchor: 'privacy' }];
        for (const params of visits) {
            expect(readDestinationInstanceTitle(catalog, { kind: 'personalize', params })).toBe(personalize.title);
        }
        expect(readDestinationInstanceTitle(catalog, { kind: 'missing-destination', params: {} })).toBeNull();
    });
    it('admits and round trips Personalize visits without adding a launcher', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        for (const href of ['/personalize', '/personalize?page=style', '/personalize?page=conversation']) {
            const target = resolveDestinationRefFromHref(catalog, href);
            expect(target, href).toEqual({ kind: 'personalize', params: href.includes('?') ? { page: href.split('=')[1] } : {} });
            expect(target && hrefForDestinationRef(catalog, target), href).toBe(href);
        }
        expect(catalog.find(destination => destination.id === 'personalize')).toMatchObject({ visibility: 'hidden' });
        expect(resolveDestinationRefFromHref(catalog, '/personalize/no-such-page')).toBeNull();
        expect(resolveDestinationRefFromHref(catalog, '/personalize?page=style&page=tools')).toBeNull();
    });
    it('leaves repeated plugin locations to Expo without choosing one value', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const href = '/settings/plugins/acme.review/policy?subPath=bindings%2F1&subPath=bindings%2F2';
        const route = { name: 'settings/plugins/[pluginId]/[pageId]', params: { pluginId: 'acme.review', pageId: 'policy' } };
        const query = parseQueryParams(href, route);
        expect(readPluginSettingsPageRouteParams({ ...query, ...route.params })?.subPath).toBeNull();
        expect(resolveDestinationRefFromHref(catalog, href)).toBeNull();
        const single = resolveDestinationRefFromHref(catalog, href.split('&')[0]!);
        expect(single).not.toBeNull();
        expect(readPluginSettingsPageRouteParams(single!.params)?.subPath).toBe('bindings/1');
    });

    it('admits only Settings locations with a hosted route body', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        expect(resolveDestinationRefFromHref(catalog, '/settings/no-such-page')).toBeNull();
        for (const href of ['/settings/embeds', '/settings/embeds/new', '/settings/embeds/token-a',
            '/settings/account/api-tokens/token-a', '/settings/voice/service']) {
            const target = resolveDestinationRefFromHref(catalog, href);
            expect(target, href).not.toBeNull();
            expect(target && hrefForDestinationRef(catalog, target), href).toBe(href);
        }
        expect(resolveDestinationRefFromHref(catalog, '/settings/account/api-tokens/token-a')?.params.tokenId).toBe('token-a');
    });
    it('keeps a managed Machine deep link distinct and scoped to its saved Home', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const href = '/settings/machines/managed/pending-a?serverId=home-b';
        const destination = resolveDestinationRefFromHref(catalog, href);
        expect(destination).toMatchObject({ kind: 'settings', params: { id: 'pending-a', serverId: 'home-b', pageId: 'machines/managed/pending-a' } });
        expect(destination && hrefForDestinationRef(catalog, destination)).toBe(href);
    });
    it('admits the real group-qualified account href and preserves its qualified identity', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
        const href = resolveHref(buildConnectedAccountSettingsRoute(service, { kind: 'account', accountId: 'account-a' }));
        const target = resolveDestinationRefFromHref(catalog, href);
        expect(target).toEqual({ kind: 'settings', params: { ...service, accountId: 'account-a', pageId: 'connected-services/account' } });
        expect(target && hrefForDestinationRef(catalog, target)).toBe('/settings/connected-services/account?pluginId=happier.agent.claude&localId=anthropic&accountId=account-a');
    });
    it('preserves nested dynamic and static route locations with canonical leaf params', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: true, workflows: true, friends: true,
        } });
        for (const href of ['/session/archived', '/session/recent', '/automations/edit?id=automation-a', '/automations/automation-a/runs/run-a',
            '/workflows/edit?id=workflow-a', '/settings/plugins/acme.notes/general',
            '/settings/agents/custom/custom-agent', '/inbox/approvals/request-a']) {
            const target = resolveDestinationRefFromHref(catalog, href);
            expect(target, href).not.toBeNull();
            expect(hrefForDestinationRef(catalog, target!), href).toBe(href);
        }
        expect(resolveDestinationRefFromHref(catalog, '/settings/agents/custom/custom-agent')?.params.backendId).toBe('custom-agent');
        expect(resolveDestinationRefFromHref(catalog, '/settings/plugins/acme.notes/general')?.params).toMatchObject({ pluginId: 'acme.notes', pageId: 'general' });
        expect(resolveDestinationRefFromHref(catalog, '/session/archived')?.kind).toBe('sessions');
        expect(resolveDestinationRefFromHref(catalog, '/session/recent')?.kind).toBe('sessions');
    });
});

const activationBoundary = vi.hoisted(() => ({
    pushed: [] as string[],
    searchOpens: 0,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: '/',
        router: { push: (href: unknown) => { activationBoundary.pushed.push(String(href)); } },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const compactCatalogProjectionState = vi.hoisted(() => ({
    value: {
        interactionEnabled: true,
        pluginUiProjection: null as PluginUiProjectionModel | null,
    },
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => compactCatalogProjectionState.value,
    // Localization is not under test here; the catalog falls back to the
    // projected developer text when no resolver is supplied.
    useProjectedPluginLocalizedTextResolver: () => undefined,
}));

const page = Object.freeze({
    id: 'plugin:acme.notes:notes',
    pluginId: 'acme.notes',
    descriptorId: 'notes',
    localId: 'notes',
    label: 'Notes',
    icon: 'note',
    order: 40,
    disabledReason: null,
    placement: {} as PluginAppPage['placement'],
    routePath: '/plugins/acme.notes/notes',
} satisfies PluginAppPage);

const appSidebarTab = Object.freeze({
    id: 'plugin:acme.review:review-panel',
    owner: 'plugin',
    label: 'Review',
    icon: 'check-square',
    order: 50,
    scopes: ['app'],
    mobileSurfaces: { app: 'plugin' },
    plugin: { pluginId: 'acme.review', descriptorId: 'review-panel', generation: 4 },
    retentionKey: 'plugin:acme.review:review-panel:4',
    placement: {
        binding: {
            destination: { pluginId: 'acme.review', localId: 'review-panel' },
        },
    },
} as unknown as RightSidebarPluginTabDefinition);

function createProjectedAppPage(): PluginUiSurfacePlacementProjection {
    return {
        id: 'surfacePlacement:acme.notes:notes',
        pluginId: 'acme.notes',
        occurrenceId: 'acme-notes-occurrence',
        contributionKind: 'surfacePlacement',
        descriptorId: 'notes',
        binding: {
            kind: 'destination',
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            container: 'appPage',
            targetKind: 'app',
        } as PluginUiSurfacePlacementProjection['binding'],
        target: { kind: 'app' },
        renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' },
        display: { developerFallback: 'Notes', iconToken: 'note' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        order: 40,
    };
}

function CompactCatalogProbe() {
    const destinations = useCompactAppDestinations();
    return React.createElement('CompactCatalogProbe', { destinations });
}

const ALL_BUILTINS = Object.freeze({
    externalSessions: true,
    inbox: true,
    workflows: true,
    friends: false,
});
const CORE_BUILTINS = Object.freeze({
    externalSessions: false,
    inbox: false,
    workflows: false,
    friends: false,
});

function pageWith(localId: string, extra: Partial<PluginAppPage> = {}): PluginAppPage {
    return Object.freeze({
        ...page,
        id: `plugin:acme.${localId}:${localId}` as const,
        pluginId: `acme.${localId}`,
        descriptorId: localId,
        localId,
        label: localId,
        routePath: `/plugins/acme.${localId}/${localId}`,
        ...extra,
    });
}

const ids = (destinations: readonly { id: string }[]) => destinations.map((destination) => destination.id);

describe('resolveCompactAppDestinations', () => {
    it('lists every built-in shell destination in the one catalog, each with its placement', () => {
        const destinations = resolveCompactAppDestinations({ builtins: ALL_BUILTINS, pages: [] });
        expect(destinations.map((destination) => [destination.id, destination.placement])).toEqual([
            ['sessions', { kind: 'rail', region: 'app' }],
            ['search', { kind: 'rail', region: 'app' }],
            ['inbox', { kind: 'rail', region: 'app' }],
            ['projects', { kind: 'rail', region: 'app' }],
            // One Workflows destination (FIN 04 §3.1): there is no Automations row.
            ['workflows', { kind: 'rail', region: 'app' }],
            // Boards (INT §5.1): its own column listing the user's boards.
            ['boards', { kind: 'rail', region: 'app' }],
            // Artifacts (RU2 §9.6): a full page over the Account Artifact store, after Boards.
            ['artifacts', { kind: 'rail', region: 'app' }],
            // Bots last of the app's own entries, standing apart with its rail pins (lab `b-rail A`).
            ['bots', { kind: 'rail', region: 'app' }],
            ['browseExistingSessions', { kind: 'column', column: 'sessions' }],
            ['plugins', { kind: 'rail', region: 'plugins' }],
            ['settings', { kind: 'rail', region: 'account' }],
            ['personalize', { kind: 'rail', region: 'account' }],
        ]);
        expect(destinations.find((destination) => destination.id === 'search')).toMatchObject({ activation: 'overlay' });
        expect(destinations.find((destination) => destination.id === 'sessions')).toMatchObject({ column: 'sessions', activation: 'navigate' });
        expect(destinations.find((destination) => destination.id === 'workflows')).toMatchObject({ column: 'workflows', routePath: '/workflows' });
        expect(destinations.find((destination) => destination.id === 'boards')).toMatchObject({ column: 'boards', routePath: '/boards' });
        expect(destinations.find((destination) => destination.id === 'artifacts')).toMatchObject({ routePath: '/artifacts', activation: 'navigate' });
        expect(destinations.find((destination) => destination.id === 'artifacts')).not.toHaveProperty('column');
        // Gated built-ins are omitted; the local Bots overlay remains honestly unavailable until its leaf mounts.
        expect(ids(resolveCompactAppDestinations({ builtins: CORE_BUILTINS, pages: [] })))
            .toEqual(['sessions', 'search', 'projects', 'boards', 'artifacts', 'bots', 'plugins', 'settings', 'personalize']);
    });

    it('places a plugin page on the rail or in a named column, and falls back to the rail for a column this host lacks', () => {
        const destinations = resolveCompactAppDestinations({
            builtins: CORE_BUILTINS,
            pages: [
                pageWith('rail'),
                pageWith('prompts', { requestedPlacement: { kind: 'column', column: 'sessions' } }),
                pageWith('later', { requestedPlacement: { kind: 'column', column: 'workflows' } }),
            ],
        });
        const placements = Object.fromEntries(destinations.map((destination) => [destination.id, destination.placement]));
        expect(placements['plugin:acme.rail:rail']).toEqual({ kind: 'rail', region: 'plugins' });
        expect(placements['plugin:acme.prompts:prompts']).toEqual({ kind: 'column', column: 'sessions' });
        expect(placements['plugin:acme.later:later']).toEqual({ kind: 'rail', region: 'plugins' });
    });

    it('retains an unavailable qualified page as its exact destination instead of substituting another launcher', () => {
        const destinations = resolveCompactAppDestinations({
            builtins: CORE_BUILTINS,
            pages: [Object.freeze({ ...page, disabledReason: 'plugin_disabled' })],
        });
        expect(destinations.find((destination) => destination.kind === 'plugin')).toMatchObject({
            id: 'plugin:acme.notes:notes',
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            availability: 'unavailable',
            unavailableReason: 'plugin_disabled',
        });
    });

    it('projects an admitted App right-sidebar tab through the same catalog', () => {
        const destinations = resolveCompactAppDestinations({
            builtins: CORE_BUILTINS,
            pages: [],
            rightSidebarTabs: [appSidebarTab],
        });
        expect(destinations.find((destination) => destination.kind === 'plugin')).toMatchObject({
            container: 'rightSidebarTab',
            id: 'rightSidebarTab:plugin:acme.review:review-panel',
            destination: { pluginId: 'acme.review', localId: 'review-panel' },
            placement: { kind: 'rail', region: 'plugins' },
            activation: 'rightSidebarTab',
            availability: 'available',
        });
    });

    it('lists one surface once when its renderer is both an App page and an App right-sidebar tab', () => {
        const sharedRenderer = { pluginId: 'acme.review', localId: 'review-renderer' };
        const reviewPage = Object.freeze({
            ...page,
            id: 'plugin:acme.review:review-page',
            pluginId: 'acme.review',
            descriptorId: 'review-page',
            localId: 'review-page',
            label: 'Review',
            placement: {
                binding: {
                    destination: { pluginId: 'acme.review', localId: 'review-page' },
                    renderer: sharedRenderer,
                },
            } as unknown as PluginAppPage['placement'],
            routePath: '/plugins/acme.review/review-page',
        } satisfies PluginAppPage);
        const sameSurfaceTab = Object.freeze({
            ...appSidebarTab,
            placement: {
                binding: {
                    destination: { pluginId: 'acme.review', localId: 'review-panel' },
                    renderer: sharedRenderer,
                },
            },
        } as unknown as RightSidebarPluginTabDefinition);
        const otherSurfaceTab = Object.freeze({
            ...appSidebarTab,
            id: 'plugin:acme.review:activity-panel',
            label: 'Activity',
            placement: {
                binding: {
                    destination: { pluginId: 'acme.review', localId: 'activity-panel' },
                    renderer: { pluginId: 'acme.review', localId: 'activity-renderer' },
                },
            },
        } as unknown as RightSidebarPluginTabDefinition);

        const plugins = resolveCompactAppDestinations({
            builtins: CORE_BUILTINS,
            pages: [reviewPage],
            rightSidebarTabs: [sameSurfaceTab, otherSurfaceTab],
        }).filter((destination) => destination.kind === 'plugin');

        expect(ids(plugins)).toEqual([
            'plugin:acme.review:review-page',
            'rightSidebarTab:plugin:acme.review:activity-panel',
        ]);
    });

    it('keeps built-in anchors ahead of plugin peers in a group; a plugin rank orders only its peers', () => {
        const destinations = resolveCompactAppDestinations({
            builtins: ALL_BUILTINS,
            pages: [
                pageWith('late', { rankHint: 5 }),
                pageWith('eager', { rankHint: -100, order: -50 }),
                pageWith('prompts', { requestedPlacement: { kind: 'column', column: 'sessions' }, rankHint: -100 }),
            ],
        });
        const plugins = destinations.filter((destination) => destination.placement.kind === 'rail' && destination.placement.region === 'plugins');
        expect(ids(plugins)).toEqual(['plugins', 'plugin:acme.eager:eager', 'plugin:acme.late:late']);
        const sessionsColumn = destinations.filter((destination) => destination.placement.kind === 'column');
        expect(ids(sessionsColumn)).toEqual(['browseExistingSessions', 'plugin:acme.prompts:prompts']);
    });
});

describe('catalog destination instances', () => {
    const catalog = resolveCompactAppDestinations({ builtins: ALL_BUILTINS, pages: [page] });

    it('round-trips distinct session, project, workflow, settings, and qualified plugin page identities', () => {
        const hrefs = [
            '/session/sess-a?serverId=home-a',
            '/projects/workspace-1',
            '/workflows/runs/run-1?invocationId=inv-1',
            '/settings/providers/connection-1/models',
            '/plugins/acme.notes/notes/folder/item',
        ];
        const refs = hrefs.map((href) => resolveDestinationRefFromHref(catalog, href));
        expect(refs).toEqual([
            { kind: 'session', params: { id: 'sess-a', serverId: 'home-a' } },
            { kind: 'project', params: { workspaceRefId: 'workspace-1' } },
            { kind: 'workflowRun', params: { runId: 'run-1', invocationId: 'inv-1' } },
            { kind: 'settings', params: { pageId: 'providers/connection-1/models', connectionId: 'connection-1' } },
            { kind: page.id, params: { pluginId: 'acme.notes', localId: 'notes', subPath: 'folder/item' } },
        ]);
        expect(refs.map((ref) => ref && hrefForDestinationRef(catalog, ref))).toEqual(hrefs);
    });

    it('does not confuse sibling session servers or plugin page prefixes', () => {
        expect(resolveDestinationRefFromHref(catalog, '/session/sess-a?serverId=home-b')).toEqual({
            kind: 'session', params: { id: 'sess-a', serverId: 'home-b' },
        });
        expect(resolveDestinationRefFromHref(catalog, '/plugins/acme.notes/notes2')).toBeNull();
    });

    it('keeps session details and automation identities addressable as tabs', () => {
        const details = '/session/sess-a/details?serverId=home-a&details=file&path=src%2Findex.ts';
        const automation = '/automations/auto-1';
        expect(resolveDestinationRefFromHref(catalog, details)).toEqual({
            kind: 'sessionDetails',
            params: { id: 'sess-a', serverId: 'home-a', details: 'file', path: 'src/index.ts' },
        });
        expect(hrefForDestinationRef(catalog, resolveDestinationRefFromHref(catalog, details)!)).toBe(details);
        expect(resolveDestinationRefFromHref(catalog, automation)).toEqual({
            kind: 'automation', params: { id: 'auto-1' },
        });
        expect(hrefForDestinationRef(catalog, resolveDestinationRefFromHref(catalog, automation)!)).toBe(automation);
    });

    it('addresses a new pull request as a session-scoped Details destination', () => {
        const tab = createSessionScmPullRequestDetailsTab();
        const detailsParams = buildActiveDetailsRouteParams([tab], tab.key);
        const href = `/session/sess-a/details?serverId=home-a&${new URLSearchParams(detailsParams)}`;
        const ref = resolveDestinationRefFromHref(catalog, href);
        expect(ref).toEqual({
            kind: 'sessionDetails',
            params: { id: 'sess-a', serverId: 'home-a', details: 'scmPullRequest' },
        });
        expect(hrefForDestinationRef(catalog, ref!)).toBe(href);
    });

    it('rejects Details destinations that the existing Details owner cannot render', () => {
        for (const href of [
            '/session/sess-a/details?serverId=home-a&details=newPullRequest',
            '/session/sess-a/details?details=file',
            '/session/sess-a/details?details=file&path=..%2Fprivate',
            '/session/sess-a/details?details=discussion',
            '/session/sess-a/details/extra?details=scmPullRequest',
        ]) {
            expect(resolveDestinationRefFromHref(catalog, href), href).toBeNull();
        }
        expect(hrefForDestinationRef(catalog, {
            kind: 'sessionDetails', params: { id: 'sess-a', details: 'newPullRequest' },
        })).toBeNull();
    });

    it('preserves independent Details targets and Home addresses for one session', () => {
        const hrefs = [
            '/session/sess-a/details?serverId=home-a&details=file&path=src%2Fa.ts',
            '/session/sess-a/details?serverId=home-a&details=file&path=src%2Fb.ts',
            '/session/sess-a/details?serverId=home-b&details=file&path=src%2Fa.ts',
            '/session/sess-a/details?serverId=home-a&details=board&boardItemId=item-1',
            '/session/sess-a/details?serverId=home-a&details=terminal&terminalInstanceId=term-2',
        ];
        const refs = hrefs.map((href) => resolveDestinationRefFromHref(catalog, href));
        expect(refs.every((ref) => ref?.kind === 'sessionDetails' && ref.params.id === 'sess-a')).toBe(true);
        expect(new Set(refs.map((ref) => JSON.stringify(ref))).size).toBe(hrefs.length);
        expect(refs.map((ref) => ref && hrefForDestinationRef(catalog, ref))).toEqual(hrefs);
    });

    it('keeps project subpages and workflow definitions distinct from their parent collections', () => {
        const projectFiles = '/projects/workspace-1/code?worktreeId=tree-2';
        const workflow = '/workflows/workflow-1';
        expect(resolveDestinationRefFromHref(catalog, projectFiles)).toEqual({
            kind: 'project',
            params: { workspaceRefId: 'workspace-1', pageId: 'code', worktreeId: 'tree-2' },
        });
        expect(hrefForDestinationRef(catalog, resolveDestinationRefFromHref(catalog, projectFiles)!)).toBe(projectFiles);
        expect(resolveDestinationRefFromHref(catalog, workflow)).toEqual({
            kind: 'workflow', params: { id: 'workflow-1' },
        });
        // The destination's own pages are not workflow identities.
        expect(resolveDestinationRefFromHref(catalog, '/workflows/settings')?.kind).not.toBe('workflow');
        expect(resolveDestinationRefFromHref(catalog, '/workflows/runs')?.kind).not.toBe('workflow');
        expect(hrefForDestinationRef(catalog, resolveDestinationRefFromHref(catalog, workflow)!)).toBe(workflow);
    });

    it('preserves the Project file anchor query and refuses unpublished aliases', () => {
        const href = '/projects/workspace-1/code?serverId=home-b&worktreeId=checkout-a&initialFile=src%2Fa.ts&anchor=range&startLine=9&endLine=12';
        const ref = resolveDestinationRefFromHref(catalog, href);
        expect(ref).not.toBeNull();
        expect(hrefForDestinationRef(catalog, ref!)).toBe(href);
        for (const alias of ['files', 'git', 'details']) {
            expect(resolveDestinationRefFromHref(catalog, `/projects/workspace-1/${alias}`)).toBeNull();
            expect(hrefForDestinationRef(catalog, { kind: 'project', params: { workspaceRefId: 'workspace-1', pageId: alias } })).toBeNull();
        }
    });
    it('preserves an addressed setting when a page is opened from search', () => {
        const href = '/settings/appearance?setting=theme#theme';
        const ref = resolveDestinationRefFromHref(catalog, href);
        expect(ref).toEqual({
            kind: 'settings',
            params: { pageId: 'appearance', setting: 'theme', anchor: 'theme' },
        });
        expect(hrefForDestinationRef(catalog, ref!)).toBe(href);
    });
});

describe('resolveCurrentAppDestination', () => {
    const catalog = resolveCompactAppDestinations({
        builtins: ALL_BUILTINS,
        pages: [page, pageWith('prompts', { requestedPlacement: { kind: 'column', column: 'sessions' } })],
        rightSidebarTabs: [appSidebarTab],
    });
    const at = (pathname: string) => resolveCurrentAppDestination(catalog, pathname)?.id ?? null;

    it('resolves claimed routes to their most specific destination and leaves unclaimed routes without one', () => {
        expect(at('/')).toBe('sessions');
        expect(at('/session/abc/files')).toBe('sessions');
        expect(at('/runs')).toBeNull();
        expect(at('/new/pick/server')).toBeNull();
        expect(at('/workflows')).toBe('workflows');
        expect(at('/workflows/wf-1')).toBe('workflows');
        expect(at('/boards')).toBe('boards');
        expect(at('/boards/board-1')).toBe('boards');
        expect(at('/artifacts')).toBe('artifacts');
        expect(at('/artifacts/artifact-1')).toBe('artifacts');
        expect(at('/artifacts/edit/artifact-1')).toBe('artifacts');
        expect(at('/projects')).toBe('projects');
        expect(at('/projects/ws-1/code')).toBe('projects');
        expect(at('/inbox/approvals')).toBe('inbox');
        // The Automation pages that remain open inside the one Workflows destination.
        expect(at('/automations/a-1')).toBe('workflows');
        expect(at('/search')).toBe('search');
        expect(at('/external/browse')).toBe('browseExistingSessions');
        expect(at('/settings/home/srv%201/people/acc')).toBe('settings');
        expect(at('/settings/plugins/panels')).toBe('settings');
        expect(at('/plugins/')).toBe('plugins');
        expect(at('/plugins/listing')).toBe('plugins');
        expect(at('/plugins/acme.tools')).toBe('plugins');
        // A plugin page this viewer no longer has keeps its tombstone under Plugins, not Sessions.
        expect(at('/plugins/acme.gone/page')).toBe('plugins');
        expect(at('/plugins/acme.notes/notes')).toBe('plugin:acme.notes:notes');
        expect(at('/plugins/acme.notes/notes/history/1')).toBe('plugin:acme.notes:notes');
        expect(at('/plugins/acme.prompts/prompts')).toBe('plugin:acme.prompts:prompts');
    });
});

describe('useActivateAppDestination', () => {
    it('keeps the Bots roster distinct from Search and does not navigate without its mounted roster owner', async () => {
        const catalog = resolveCompactAppDestinations({ builtins: ALL_BUILTINS, pages: [] });
        const bots = catalog.find(destination => destination.id === 'bots');
        expect(bots).toMatchObject({ activation: 'botsRoster', availability: 'unavailable', placement: { kind: 'rail', region: 'app' } });
        const before = { pushed: [...activationBoundary.pushed], searchOpens: activationBoundary.searchOpens };
        let activate: ReturnType<typeof useActivateAppDestination> | null = null;
        function Probe() { activate = useActivateAppDestination(); return null; }
        await renderScreen(React.createElement(UniversalSearchRuntimeProvider,
            { value: { open: () => { activationBoundary.searchOpens += 1; }, buildCommands: () => [] } },
            React.createElement(Probe)));
        activate!(bots!);
        expect(activationBoundary.pushed).toEqual(before.pushed);
        expect(activationBoundary.searchOpens).toBe(before.searchOpens);
    });

    it('opens Bots only through its supplied mounted roster owner', async () => {
        let rosterOpens = 0;
        const owner = { openBotsRoster: () => { rosterOpens += 1; } };
        const catalog = resolveCompactAppDestinations({ builtins: { ...ALL_BUILTINS, botsRoster: true }, pages: [] });
        const bots = catalog.find(destination => destination.id === 'bots');
        expect(bots).toMatchObject({ activation: 'botsRoster', availability: 'available' });
        const before = { pushed: [...activationBoundary.pushed], searchOpens: activationBoundary.searchOpens };
        let activate: ReturnType<typeof useActivateAppDestination> | null = null;
        function Probe() { activate = useActivateAppDestination(owner); return null; }
        await renderScreen(React.createElement(Probe));
        activate!(bots!);
        expect(rosterOpens).toBe(1);
        expect(activationBoundary.pushed).toEqual(before.pushed);
        expect(activationBoundary.searchOpens).toBe(before.searchOpens);
    });

    it('navigates, opens Search over the page, and activates plugin pages through one hook', async () => {
        const catalog = resolveCompactAppDestinations({ builtins: ALL_BUILTINS, pages: [page] });
        const byId = (id: string) => catalog.find((destination) => destination.id === id)!;
        let activate: ReturnType<typeof useActivateAppDestination> | null = null;
        function Probe() {
            activate = useActivateAppDestination();
            return null;
        }
        // The palette owns the Universal Search runtime; any consumer reaches it through this context.
        await renderScreen(React.createElement(
            UniversalSearchRuntimeProvider,
            { value: { open: () => { activationBoundary.searchOpens += 1; }, buildCommands: () => [] } },
            React.createElement(Probe),
        ));

        activate!(byId('workflows'));
        activate!(byId('search'), { searchScope: undefined });
        activate!(byId('plugin:acme.notes:notes'));
        const unavailablePage = resolveCompactAppDestinations({
            builtins: CORE_BUILTINS, pages: [{ ...page, disabledReason: 'plugin_disabled' }],
        }).find(destination => destination.kind === 'plugin');
        activate!(unavailablePage!);

        // Available pages use their launch owner; unavailable pages retain their
        // exact route-owned recovery rather than silently dropping activation.
        expect(activationBoundary.pushed).toEqual(['/workflows', '/plugins/acme.notes/notes', '/plugins/acme.notes/notes']);
        expect(activationBoundary.searchOpens).toBe(1);
    });
});

describe('useCompactAppDestinations', () => {
    it('makes Bots available to every list once the app-wide roster runtime is mounted, and opens it there', async () => {
        const outside = await renderScreen(React.createElement(CompactCatalogProbe));
        expect(outside.tree.findByType('CompactCatalogProbe' as never).props.destinations
            .find((destination: { id: string }) => destination.id === 'bots')?.availability).toBe('unavailable');

        let rosterOpens = 0;
        let activate: ReturnType<typeof useActivateAppDestination> | null = null;
        function ActivationProbe() { activate = useActivateAppDestination(); return null; }
        const screen = await renderScreen(React.createElement(BotsRosterRuntimeProvider, null,
            React.createElement(CompactCatalogProbe), React.createElement(ActivationProbe),
            React.createElement(function AnchorProbe() {
                const runtime = useOptionalBotsRosterRuntime();
                React.useEffect(() => runtime?.registerAnchoredOpener(() => { rosterOpens += 1; }), [runtime]);
                return null;
            })));
        const bots = screen.tree.findByType('CompactCatalogProbe' as never).props.destinations
            .find((destination: { id: string }) => destination.id === 'bots');
        expect(bots?.availability).toBe('available');
        const before = [...activationBoundary.pushed];
        activate!(bots);
        expect(rosterOpens).toBe(1);
        expect(activationBoundary.pushed).toEqual(before);
    });
    it('keeps rail-only placement preferences out of shared destination discovery', async () => {
        const screen = await renderScreen(React.createElement(CompactCatalogProbe));
        const destinations = screen.tree.findByType('CompactCatalogProbe' as never).props.destinations;
        expect(destinations[0].id).toBe('sessions');
        expect(destinations.find((destination: { id: string }) => destination.id === 'sessions')?.visibility).not.toBe('hidden');
        expect(destinations.find((destination: { id: string }) => destination.id === 'personalize')?.visibility).toBe('hidden');
    });
    it('keeps an admitted app page discoverable while daemon interaction is offline', async () => {
        compactCatalogProjectionState.value = {
            interactionEnabled: false,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                generation: 1,
                surfacePlacementsById: {
                    'surfacePlacement:acme.notes:notes': createProjectedAppPage(),
                },
            },
        };

        const screen = await renderScreen(React.createElement(CompactCatalogProbe));
        const probe = screen.tree.findByType('CompactCatalogProbe' as never);

        // Built-ins follow their own availability owners; the admitted page is listed regardless.
        expect(probe.props.destinations).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'sessions', routePath: '/' }),
            expect.objectContaining({ id: 'plugins', routePath: '/plugins' }),
            expect.objectContaining({
                kind: 'plugin',
                destination: { pluginId: 'acme.notes', localId: 'notes' },
                routePath: '/plugins/acme.notes/notes',
                availability: 'available',
            }),
            expect.objectContaining({ id: 'settings', routePath: '/settings' }),
        ]));
    });
});
