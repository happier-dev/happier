import type * as React from 'react';
import type { IconName } from '@/components/ui/icons/Icon';
import { HappierStorageCategoryIdV1Schema } from '@happier-dev/protocol/storage/storageV1';

import { GuardBarAccessory } from '@/components/machines/guard/GuardBarAccessory';
import { GuardTab } from '@/components/machines/guard/GuardTab';
import { MachineProcessesTab, parseMachineProcessesParams } from '@/components/machines/processes/MachineProcessesTab';
import { MachineStorageTab, StorageTabBarAccessory } from '@/components/machines/storage/MachineStorageTab';
import type { TranslationKeyNoParams } from '@/text';

import { MachineVitalsBarAccessory } from '@/components/machines/vitals/MachineVitalsRangeBar';

import { MachineServicesTab } from '@/components/machines/services/MachineServicesTab';

import { MachineOverview } from './MachineOverview';
import type { MachinePageTabId, MachinePageTabParams, MachinePageTabBodyProps, MachinePageTabBarAccessoryProps } from './machinePageTabQuery';

/**
 * The machine page's tabs (R2: Overview · Processes · Storage · Guard). One typed static table, edited
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
    /** Reads this tab's params from the route query; unknown values fall back to the tab's defaults. */
    parseParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams;
}>;

const OVERVIEW_PARAMS: MachinePageTabParams = Object.freeze({ id: 'overview' });
const STORAGE_PARAMS: MachinePageTabParams = Object.freeze({ id: 'storage' });

const GUARD_PARAMS: MachinePageTabParams = Object.freeze({ id: 'guard' });
const SERVICES_PARAMS: MachinePageTabParams = Object.freeze({ id: 'services' });

/** Services' own params: one service's page or the deployment roles page when the route names it, else the list. */
function parseServicesParams(raw: Readonly<Record<string, string | undefined>>): MachinePageTabParams {
    const service = raw.service?.trim();
    if (raw.page === 'roles') return { id: 'services', page: 'roles' };
    return raw.page === 'service' && service ? { id: 'services', page: 'service', service } : SERVICES_PARAMS;
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
    { id: 'overview', titleKey: 'machineDetailPage.tabs.overview', Body: MachineOverview, BarAccessory: MachineVitalsBarAccessory, parseParams: () => OVERVIEW_PARAMS },
    { id: 'services', titleKey: 'machineServices.tab', Body: MachineServicesTab, suspendWhenHidden: true, parseParams: parseServicesParams },
    { id: 'processes', titleKey: 'machineProcesses.tab', Body: MachineProcessesTab, suspendWhenHidden: true, parseParams: parseMachineProcessesParams },
    { id: 'storage', titleKey: 'machineStorage.tab', Body: MachineStorageTab, suspendWhenHidden: true, BarAccessory: StorageTabBarAccessory, parseParams: parseStorageParams },
    { id: 'guard', titleKey: 'machineGuard.tab', Body: GuardTab, suspendWhenHidden: true, BarAccessory: GuardBarAccessory, parseParams: parseGuardParams },
];

/**
 * The tab the route names (`tab` + that tab's own params). A missing or unknown tab is Overview, so an
 * older or mistyped link still opens the page (tolerant reader).
 */
export function resolveMachinePageTab(raw: Readonly<Record<string, string | undefined>>): Readonly<{
    entry: MachinePageTabEntry;
    params: MachinePageTabParams;
}> {
    const entry = MACHINE_PAGE_TABS.find(candidate => candidate.id === raw.tab) ?? MACHINE_PAGE_TABS[0]!;
    return { entry, params: entry.parseParams(raw) };
}
