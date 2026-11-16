import type * as React from 'react';
import { normalizePluginUiSubPathV1, PluginUiDestinationReferenceV1Schema } from '@happier-dev/protocol/plugins/ui';
import { HappierStorageCategoryIdV1Schema } from '@happier-dev/protocol/storage/storageV1';

import { GuardBarAccessory } from '@/components/machines/guard/GuardBarAccessory';
import { GuardTab } from '@/components/machines/guard/GuardTab';
import { MachineProcessesTab, parseMachineProcessesParams } from '@/components/machines/processes/MachineProcessesTab';
import { MachineStorageTab, StorageTabBarAccessory } from '@/components/machines/storage/MachineStorageTab';
import { MachineSecurityTab } from '@/components/machines/security/MachineSecurityTab';
import { MachineSandboxesTab } from '@/components/machines/sandboxes/MachineSandboxesTab';
import { MACHINE_ISOLATION_WORK_KINDS } from '@/components/machines/security/isolation/machineIsolationChoices';
import { MachineScheduledTab } from '@/components/machines/scheduled/MachineScheduledTab';
import { MachineSetupTab, parseMachineSetupParams } from '@/components/machines/setup/MachineSetupTab';
import type { TranslationKeyNoParams } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';

import { MachineVitalsBarAccessory } from '@/components/machines/vitals/MachineVitalsRangeBar';

import { MachineServicesTab } from '@/components/machines/services/MachineServicesTab';

import { MachineOverview } from './MachineOverview';
import { MachinePluginPageTab } from './MachinePluginPageTab';
import { machinePageTabEntryKey, machinePageTabKey, type MachinePageTabId, type MachinePageTabParams, type MachinePageTabBodyProps, type MachinePageTabBarAccessoryProps } from './machinePageTabQuery';
export { machinePageTabEntryKey } from './machinePageTabQuery';

/**
 * The machine page's tabs (R2: Overview · Services · Processes · Storage · Guard; MACH-COMPOSE D1 adds Setup and Security). One typed static table, edited
 * by the plan that lands a tab body: no registry, no contribution family. A tab is listed only once its
 * body exists; with Overview alone the page draws no tab bar.
 */
export type MachinePageTabEntry = (Readonly<{ titleKey: TranslationKeyNoParams; label?: undefined }>
    /** A plugin page carries its declaration's resolved title. */
    | Readonly<{ label: string; titleKey?: undefined }>) & Readonly<{
    id: MachinePageTabId;
    /** Set when one id names several tabs (each plugin page); otherwise the id is the tab's key. */
    key?: string;
    icon?: IconName;
    disabledReason?: string | null;
    Body: React.ComponentType<MachinePageTabBodyProps>;
    /** Drawn at the end of the tab bar on wide layouts while this tab is open; phones keep it in the body. */
    BarAccessory?: React.ComponentType<MachinePageTabBarAccessoryProps>;
    /** Core-only bodies may suspend while hidden. Bodies with arbitrary plugin regions retain their effects. */
    suspendWhenHidden?: boolean;
    /**
     * A body with nothing that must run while hidden (no in-flight action, approval or scoped binding) hides through
     * Activity: its effects withdraw and it renders nothing until shown. A frozen body is re-attempted, with a retry
     * render, on every store update while hidden.
     */
    hiddenMode?: 'activity';
    /** Reads this tab's params from the route query; unknown values fall back to the tab's defaults. */
    parseParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams;
    /**
     * A page this tab pushes whose list is too long to mount whole draws its own virtualized scroller (the
     * `MachinePageListHost` carries it the header and tabs), instead of scrolling inside the page's one `ItemList`.
     */
    ownsScroll?(params: MachinePageTabParams): boolean;
}>;

const OVERVIEW_PARAMS: MachinePageTabParams = Object.freeze({ id: 'overview' });
const STORAGE_PARAMS: MachinePageTabParams = Object.freeze({ id: 'storage' });

const GUARD_PARAMS: MachinePageTabParams = Object.freeze({ id: 'guard' });
const SCHEDULED_PARAMS: MachinePageTabParams = Object.freeze({ id: 'scheduled' });
const SERVICES_PARAMS: MachinePageTabParams = Object.freeze({ id: 'services' });
const SECURITY_PARAMS: MachinePageTabParams = Object.freeze({ id: 'security' });
const SANDBOXES_PARAMS: MachinePageTabParams = Object.freeze({ id: 'sandboxes' });

/** Services' own params: one service's page or the deployment roles page when the route names it, else the list. */
function parseServicesParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams {
    const service = raw.service?.trim();
    if (raw.page === 'roles') return { id: 'services', page: 'roles' };
    return raw.page === 'service' && service ? { id: 'services', page: 'service', service } : SERVICES_PARAMS;
}

/** Security's own params: the tab, or the Network, Sharing or Isolation page it pushes; anything else reads as the tab. */
function parseSecurityParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams {
    if (raw.page === 'isolation') {
        const add = MACHINE_ISOLATION_WORK_KINDS.find(kind => kind === raw.add);
        return { id: 'security', page: 'isolation', ...(add ? { add } : {}) };
    }
    return raw.page === 'network' || raw.page === 'sharing' ? { id: 'security', page: raw.page } : SECURITY_PARAMS;
}

function parseGuardParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams {
    return raw.page === 'activity' ? { id: 'guard', page: 'activity' } : GUARD_PARAMS;
}

const STORAGE_PAGES = new Set(['worktrees', 'suggestions', 'protected'] as const);

/** Storage's own params (plan 40 §4.11); anything unknown reads as the Happier view. */
export function parseStorageParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams {
    const categoryId = HappierStorageCategoryIdV1Schema.safeParse(raw.categoryId);
    if (raw.page === 'category' && categoryId.success) return { id: 'storage', page: 'category', categoryId: categoryId.data };
    const page = STORAGE_PAGES.has(raw.page as 'worktrees') ? raw.page as 'worktrees' | 'suggestions' | 'protected' : undefined;
    if (page) return { id: 'storage', page };
    if (raw.view === 'disk') {
        return { id: 'storage', view: 'disk', ...(raw.nodeId ? { nodeId: raw.nodeId } : {}),
            ...(raw.files === 'large' || raw.files === 'old' ? { files: raw.files } : {}), ...(raw.volumeId ? { volumeId: raw.volumeId } : {}) };
    }
    if (raw.prepare === 'lowDisk' && raw.volumeId) return { id: 'storage', prepare: 'lowDisk', volumeId: raw.volumeId };
    return STORAGE_PARAMS;
}

export const MACHINE_PAGE_TABS: readonly MachinePageTabEntry[] = [
    { id: 'overview', icon: 'desktop', titleKey: 'machineDetailPage.tabs.overview', Body: MachineOverview, BarAccessory: MachineVitalsBarAccessory, parseParams: () => OVERVIEW_PARAMS },
    { id: 'services', icon: 'stack', titleKey: 'machineServices.tab', Body: MachineServicesTab, suspendWhenHidden: true, parseParams: parseServicesParams },
    { id: 'scheduled', icon: 'clock', titleKey: 'machineScheduled.title', Body: MachineScheduledTab, suspendWhenHidden: true, parseParams: () => SCHEDULED_PARAMS },
    { id: 'processes', icon: 'cpu', titleKey: 'machineProcesses.tab', Body: MachineProcessesTab, hiddenMode: 'activity', parseParams: parseMachineProcessesParams },
    { id: 'storage', icon: 'hard-drives', titleKey: 'machineStorage.tab', Body: MachineStorageTab, hiddenMode: 'activity', BarAccessory: StorageTabBarAccessory, parseParams: parseStorageParams,
        ownsScroll: params => params.id === 'storage' && params.page === 'suggestions' },
    { id: 'guard', icon: 'shield', titleKey: 'machineGuard.tab', Body: GuardTab, hiddenMode: 'activity', BarAccessory: GuardBarAccessory, parseParams: parseGuardParams },
    { id: 'setup', icon: 'file-text', titleKey: 'machineDetailPage.tabs.setup', Body: MachineSetupTab, suspendWhenHidden: true, parseParams: parseMachineSetupParams },
    { id: 'security', icon: 'shield-check', titleKey: 'machineDetailPage.subPages.security', Body: MachineSecurityTab, suspendWhenHidden: true, parseParams: parseSecurityParams },
    { id: 'sandboxes', icon: 'cube', titleKey: 'machineDetailPage.isolation.host.tab', Body: MachineSandboxesTab, suspendWhenHidden: true, parseParams: () => SANDBOXES_PARAMS },
];

export type MachinePagePluginTabEntry = MachinePageTabEntry & Readonly<{ id: 'plugin'; key: string; pluginId: string; localId: string; label: string }>;

/** A plugin page's params from the route: its exact qualified destination, and its canonical local location. */
function parseMachinePagePluginParams(raw: Readonly<Record<string, string | undefined>>): Extract<MachinePageTabParams, { id: 'plugin' }> | null {
    if ([raw.pluginId, raw.localId].some(value => !value || /[/\\\u0000-\u001f\u007f]/u.test(value) || value === '.' || value === '..')) return null;
    const reference = PluginUiDestinationReferenceV1Schema.safeParse({ pluginId: raw.pluginId, localId: raw.localId });
    const pluginPath = normalizePluginUiSubPathV1(raw.pluginPath ?? '');
    if (!reference.success || pluginPath === null || reference.data.pluginId !== raw.pluginId || reference.data.localId !== raw.localId) return null;
    return { id: 'plugin', pluginId: reference.data.pluginId, localId: reference.data.localId, ...(pluginPath ? { pluginPath } : {}) };
}

/** One admitted plugin Machine page as a tab after the core tabs (plan 30 §3.7); its body mounts the page itself. */
export function machinePagePluginTabEntry(page: Readonly<{ pluginId: string; localId: string; label: string; icon?: IconName; disabledReason?: string | null }>): MachinePagePluginTabEntry {
    const root = { id: 'plugin' as const, pluginId: page.pluginId, localId: page.localId };
    return {
        id: 'plugin', key: machinePageTabKey(root), pluginId: page.pluginId, localId: page.localId, label: page.label,
        icon: page.icon ?? 'puzzle-piece', disabledReason: page.disabledReason,
        Body: MachinePluginPageTab,
        // A plugin page runs arbitrary plugin regions: it keeps its effects while another tab shows.
        parseParams: raw => parseMachinePagePluginParams(raw) ?? root,
    };
}

/**
 * The tab the route names (`tab` + that tab's own params). A missing or unknown tab is Overview, so an
 * older or mistyped link still opens the page (tolerant reader). A well-formed plugin page link opens that page
 * even before the catalog lists it: its body says loading or unavailable rather than silently showing Overview.
 */
export function resolveMachinePageTab(raw: Readonly<Record<string, string | undefined>>, tabs: readonly MachinePageTabEntry[] = MACHINE_PAGE_TABS): Readonly<{
    entry: MachinePageTabEntry;
    params: MachinePageTabParams;
}> {
    if (raw.tab === 'plugin') {
        const params = parseMachinePagePluginParams(raw);
        if (params) {
            const key = machinePageTabKey(params);
            const entry = tabs.find(candidate => machinePageTabEntryKey(candidate) === key)
                ?? machinePagePluginTabEntry({ pluginId: params.pluginId, localId: params.localId, label: params.localId });
            return { entry, params };
        }
    }
    const entry = tabs.find(candidate => candidate.id !== 'plugin' && candidate.id === raw.tab) ?? tabs[0]!;
    return { entry, params: entry.parseParams(raw) };
}
