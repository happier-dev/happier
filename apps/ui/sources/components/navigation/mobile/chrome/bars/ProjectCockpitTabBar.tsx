import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import {
  PROJECT_PAGES,
  normalizeProjectMobileSurface,
  normalizeProjectPage,
  type ProjectMobileSurface,
  type ProjectPageV1,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { getRightSidebarTabLabel, resolveProjectRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { resolveRightSidebarMobileProjection, resolveRightSidebarMobileSurface } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { projectPageLabel } from '@/components/projects/shell/ProjectShellHeader';
import {
  CockpitTabBar,
  CockpitTabBarAction,
  type CockpitTabBarTabDefinition,
} from './CockpitTabBar';

type ProjectCockpitTabBarProps = Readonly<{
  workspaceRefId: string;
  activeSurface: ProjectMobileSurface;
  activePage?: ProjectPageV1;
  terminalTabAvailable?: boolean;
  onSurfacePress: (surface: ProjectMobileSurface) => void;
}>;

type ProjectCockpitDestination = Readonly<{
  id: ProjectMobileSurface;
  label: string;
  icon: IconName;
}>;

const PAGE_ICONS: Readonly<Record<(typeof PROJECT_PAGES)[number], IconName>> = {
  overview: 'list-bullets',
  code: 'code',
  changes: 'git-branch',
  scripts: 'play',
  services: 'hard-drives',
  context: 'stack',
};

/**
 * The phone's Project bar (12s1, lab `p-overview` HOMEp): the six pages in order, as many as the
 * capsule holds, then More with the rest — Context stays reachable there with its selected state —
 * and the registry's companions plus the Details affordance. The capsule's room decides, not a count.
 */
export const ProjectCockpitTabBar = React.memo(
  (props: ProjectCockpitTabBarProps) => {
    const [moreOpen, setMoreOpen] = React.useState(false);
    const windowWidth = useWindowDimensions().width;
    const tabMinWidth = resolveTabBarMetrics(
      useSetting('tabBarSize'),
      useSetting('tabBarShowLabels'),
    ).tabMinWidth;
    const slotCount = resolveFloatingTabBarSlotCount({
      windowWidth,
      maxWidth: layout.maxWidth,
      tabMinWidth,
    });
    const pages: readonly ProjectCockpitDestination[] = PROJECT_PAGES.map(
      (page) => ({
        id: page,
        label: projectPageLabel(page),
        icon: PAGE_ICONS[page],
      }),
    );
    const registry = resolveProjectRightSidebarTabs({ presentation: 'mobile',
      activePage: props.activePage ?? normalizeProjectPage(props.activeSurface) ?? 'overview',
      terminalTabAvailable: props.terminalTabAvailable === true });
    const companions: readonly ProjectCockpitDestination[] = [
      ...resolveRightSidebarMobileProjection({ scope: 'project', tabs: registry }).flatMap((entry) => {
        const surface = normalizeProjectMobileSurface(entry.surface);
        // Scripts and Services already occur once in the canonical page list.
        if (!surface || normalizeProjectPage(surface)) return [];
        return [{ id: surface, label: getRightSidebarTabLabel(entry.tab),
          icon: entry.tab.icon }];
      }),
      // Details is an affordance, not another right-sidebar destination.
      { id: 'tabs', label: t('phoneNav.bar.openFiles'), icon: 'files' },
    ];
    // Every page fits only with room for nothing else; otherwise one slot is More.
    const onBar =
      pages.length <= slotCount ? pages.length : Math.max(1, slotCount - 1);
    const tabs: readonly CockpitTabBarTabDefinition<ProjectMobileSurface>[] =
      pages.slice(0, onBar);
    const behindMore = [...pages.slice(onBar), ...companions];
    const activeBehindMore =
      behindMore.find((entry) => entry.id === props.activeSurface) ?? null;
    const retainedTab = !normalizeProjectPage(props.activeSurface) ? registry.find((tab) =>
      resolveRightSidebarMobileSurface(tab, 'project') === props.activeSurface) : undefined;
    const activeMore = activeBehindMore ?? (retainedTab ? {
      label: getRightSidebarTabLabel(retainedTab),
      icon: retainedTab.icon,
    } : null);
    const items: readonly DropdownMenuItem[] = behindMore.map((entry) => ({
      id: entry.id,
      title: entry.label,
      icon: <Icon name={entry.icon} size={18} />,
      category: pages.some((page) => page.id === entry.id)
        ? 'pages'
        : 'companions',
      checked: entry.id === props.activeSurface,
      testID: `project-cockpit-more-item:${entry.id}`,
    }));

    return (
      <CockpitTabBar
        activeSurface={props.activeSurface}
        barTestId={`project-cockpit-tabbar-${props.workspaceRefId}`}
        tabs={tabs}
        tabTestIdPrefix="project-cockpit-tab-"
        layout="fit"
        onSurfacePress={props.onSurfacePress}
        trailing={
          <DropdownMenu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            items={items}
            selectedId={activeBehindMore?.id ?? null}
            onSelect={(surface) => {
              setMoreOpen(false);
              const selected = normalizeProjectMobileSurface(surface);
              if (selected) props.onSurfacePress(selected);
            }}
            matchTriggerWidth={false}
            placement="top"
            trigger={({ open, toggle }) => (
              <CockpitTabBarAction
                testID="project-cockpit-tab-more"
                label={activeMore?.label ?? t('common.more')}
                icon={activeMore?.icon ?? 'dots-three'}
                selected={activeMore !== null}
                expanded={open}
                onPress={toggle}
              />
            )}
          />
        }
      />
    );
  },
);
