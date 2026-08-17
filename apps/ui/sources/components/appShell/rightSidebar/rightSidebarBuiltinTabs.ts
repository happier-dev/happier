import type { TranslationKey } from '@/text';
import type { PluginUiDestinationGroupHintV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginSurfaceDestinationBadge } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type RightSidebarScope = 'session' | 'project' | 'app';
export type RightSidebarPresentation = 'desktop' | 'mobile';

export type RightSidebarBuiltInTabId =
    | 'git'
    | 'files'
    | 'navigation'
    | 'agents'
    | 'terminal'
    | 'browser'
    | 'services';

export type RightSidebarMobileSurface = 'browse' | 'git' | 'navigation' | 'terminal' | 'browser' | 'services' | 'plugin';

export type RightSidebarTabOwner = 'builtin' | 'plugin';

export type RightSidebarTabBase = Readonly<{
    id: string;
    owner: RightSidebarTabOwner;
    icon: IconName;
    order: number;
    scopes: readonly RightSidebarScope[];
    mobileSurfaces?: Partial<Record<RightSidebarScope, RightSidebarMobileSurface>>;
    disabledReason?: string;
}>;

export type RightSidebarBuiltinTabDefinition = RightSidebarTabBase & Readonly<{
    id: RightSidebarBuiltInTabId;
    owner: 'builtin';
    labelKey: TranslationKey;
    available?: (input: RightSidebarAvailabilityInput) => boolean;
}>;

export type RightSidebarPluginTabDefinition = RightSidebarTabBase & Readonly<{
    id: `plugin:${string}`;
    owner: 'plugin';
    label: string;
    /** Static presentation hints carried to host catalogs; they do not rank this sidebar. */
    badge?: PluginSurfaceDestinationBadge;
    groupHint?: PluginUiDestinationGroupHintV1;
    rankHint?: number;
    placement: PluginUiSurfacePlacementProjection;
    plugin: Readonly<{
        pluginId: string;
        descriptorId: string;
        generation: number | null;
    }>;
    retentionKey: string;
}>;

export type RightSidebarTabDefinition =
    | RightSidebarBuiltinTabDefinition
    | RightSidebarPluginTabDefinition;

export type RightSidebarTabDefinitionFor<TTabId extends string> =
    RightSidebarTabDefinition & Readonly<{ id: TTabId }>;

export type RightSidebarBuiltinTabDefinitionFor<TTabId extends RightSidebarBuiltInTabId> =
    RightSidebarBuiltinTabDefinition & Readonly<{ id: TTabId }>;

export type RightSidebarAvailabilityInput = Readonly<{
    scope: RightSidebarScope;
    terminalTabAvailable: boolean;
    presentation: RightSidebarPresentation;
}>;

export const RIGHT_SIDEBAR_BUILTIN_TABS: readonly RightSidebarBuiltinTabDefinition[] = [
    {
        id: 'git',
        owner: 'builtin',
        labelKey: 'session.rightPanel.tabs.git',
        icon: 'git-branch',
        order: 10,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'git',
            project: 'git',
        },
    },
    {
        id: 'files',
        owner: 'builtin',
        labelKey: 'common.files',
        icon: 'folder',
        order: 20,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'browse',
            project: 'browse',
        },
    },
    {
        id: 'agents',
        owner: 'builtin',
        labelKey: 'session.subagents.panel.title',
        icon: 'robot',
        order: 30,
        scopes: ['session'],
    },
    {
        id: 'navigation',
        owner: 'builtin',
        labelKey: 'session.transcriptNavigation.title',
        icon: 'list',
        order: 35,
        scopes: ['session'],
        // Session-only: the timeline is derived from one session's transcript, so there is
        // nothing for it to show in the project scope.
        mobileSurfaces: {
            session: 'navigation',
        },
    },
    {
        id: 'terminal',
        owner: 'builtin',
        labelKey: 'settings.terminal',
        icon: 'terminal',
        order: 40,
        scopes: ['session'],
        mobileSurfaces: {
            session: 'terminal',
        },
        available: (input) => input.terminalTabAvailable,
    },
    {
        id: 'browser',
        owner: 'builtin',
        labelKey: 'browserSurface.title',
        icon: 'globe',
        order: 50,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'browser',
            project: 'browser',
        },
        // D1: the Browser surface is mobile-only. On desktop, Services is the single
        // services/launch surface; the redundant desktop Browser sidebar tab is removed while the
        // mobile full-screen browser surface (mobileSurfaces above) is kept.
        available: (input) => input.presentation === 'mobile',
    },
    {
        id: 'services',
        owner: 'builtin',
        labelKey: 'localServices.inventory.title',
        icon: 'hard-drives',
        order: 60,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'services',
            project: 'services',
        },
    },
];
