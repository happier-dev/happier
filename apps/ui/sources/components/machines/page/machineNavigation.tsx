import * as React from 'react';
import { resolveDetailNavigationItems, type DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { selectPresentedDetailNavigationItem, usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { MachineCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/MachineCockpitTabBar';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import type { MachinePageTabEntry } from './machinePageTabs';
import { machinePageTabEntryKey } from './machinePageTabQuery';

export const MACHINE_DESKTOP_NAVIGATION_ADDRESS = { pageKind: 'machine', device: 'desktop', section: 'pages' } as const;
export const MACHINE_PHONE_NAVIGATION_ADDRESS = { pageKind: 'machine', device: 'phone', section: 'items' } as const;
export type MachineNavigationModel = Readonly<{
    serverId: string;
    machineId: string;
    scope: ServerAccountScope | null;
    items: readonly DetailPageNavigationItem[];
    activeId: string;
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
}>;

/** The typed table keeps body/route adapters; M1 alone resolves its navigation descriptors. */
export function useMachinePageNavigation(input: Readonly<{
    serverId: string; machineId: string; scope: ServerAccountScope | null;
    tabs: readonly MachinePageTabEntry[]; activeId: string; phone: boolean; presented: boolean;
    selectTab: (id: string) => void;
}>) {
    const locale = usePreferredLanguage();
    const items = React.useMemo(() => resolveDetailNavigationItems({ scope: 'machine', pages: input.tabs.map(entry => ({
        id: machinePageTabEntryKey(entry), title: entry.label ?? t(entry.titleKey), icon: entry.icon ?? 'puzzle-piece',
        disabledReason: entry.disabledReason ?? null,
    })) }), [input.tabs, locale]);
    const navigation = usePresentedDetailNavigation({ pageKind: 'machine', identity: `${input.serverId}/${input.machineId}`,
        scope: input.scope, items, activeId: input.activeId, phone: input.phone, presented: input.presented,
        title: t('settings.machines'), selectPage: input.selectTab,
        phoneChrome: execute => {
            const props = { machineId: input.machineId, items, activeId: input.activeId,
                onSelect: (id: string) => selectPresentedDetailNavigationItem(execute, model, id) };
            return { node: <MachineCockpitTabBar {...props} />, systemModel: { kind: 'machineCockpit', props } };
        } });
    const model = React.useMemo<MachineNavigationModel>(() => ({ ...navigation.model,
        serverId: input.serverId, machineId: input.machineId }), [navigation.model, input.serverId, input.machineId]);
    return { model, placements: navigation.placements };
}

/** Every UI presenter invokes the same mounted main-column owner as agent/CLI Actions. */
export const selectMachineNavigationItem = selectPresentedDetailNavigationItem;
