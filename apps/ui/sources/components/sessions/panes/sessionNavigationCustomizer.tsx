import * as React from 'react';
import { View } from 'react-native';

import {
  resolveDetailNavigationItems,
  resolveDetailNavigationProjection,
  type DetailNavigationItem,
} from '@/components/appShell/rightSidebar/detailNavigationItems';
import {
  getRightSidebarTabLabel,
  type ResolveRightSidebarTabsInput,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type {
  DetailNavigationCustomizerSection,
  DetailNavigationDevice,
  NavigationPlacementItem,
  DetailNavigationCustomizerProps,
} from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { resolveSessionCockpitMobileCatalog, type SessionCockpitMobileCatalogEntry } from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { Modal } from '@/modal';
import {
  resolveNavigationPlacements,
  type NavigationPlacementPreferences,
} from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** A rail companion of a Session: not a page-only entry and not the Companion, which the phone presents. */
export function isSessionRailCompanion(tab: DetailNavigationItem): boolean {
  return tab.navigation.kind !== 'page' && tab.id !== 'companion';
}

/** Desktop pages beside Chat, in catalog order: what the Session column's top tabs place. */
export function resolveSessionDesktopPages(items: readonly DetailNavigationItem[]): readonly DetailNavigationItem[] {
  return resolveDetailNavigationProjection(items, 'desktop').pages.filter((tab) => tab.id !== 'chat');
}

/** A page-only entry starts on the strip; a page that is also a companion keeps its rail default. */
export function sessionPageDefaultPlacement(tab: DetailNavigationItem): NavigationPlacementItem['defaultPlacement'] {
  return tab.navigation.kind === 'page' ? 'pinned' : tab.defaultPlacement;
}

const RAIL_GROUP_TITLE_KEYS = {
  session: 'navigationPlacement.railGroupSession',
  code: 'navigationPlacement.railGroupCode',
  machine: 'navigationPlacement.railGroupMachine',
  plugins: 'navigationPlacement.railGroupPlugins',
} as const;

function railGroupOf(tab: RightSidebarTabDefinition): string {
  return tab.owner === 'builtin' ? tab.railGroup : 'plugins';
}

function placementItem(
  tab: DetailNavigationItem,
  defaults: Pick<NavigationPlacementItem, 'defaultPlacement' | 'group'>,
): NavigationPlacementItem {
  return {
    id: tab.id,
    title: getRightSidebarTabLabel(tab),
    icon: tab.icon,
    allowedPlacements: tab.allowedPlacements,
    ...(tab.disabledReason ? { placementNote: tab.disabledReason } : {}),
    ...defaults,
  };
}

const ignoreSelect = () => {};

/** The desktop top tabs at static props: the same plain page strip the Session column draws. */
function PagesPreview(
  props: Readonly<{
    pages: readonly NavigationPlacementItem[];
    preferences: NavigationPlacementPreferences;
  }>,
) {
  const pinned = resolveNavigationPlacements(
    props.pages,
    props.preferences,
  ).pinned;
  const tabs = [
    {
      id: 'chat',
      label: t('phoneNav.rail.chatPane'),
      icon: <Icon name="chat-circle" size={ICON_SIZE.sm} />,
    },
    ...pinned.map((page) => ({
      id: page.id,
      label: page.title,
      icon: page.icon ? (
        <Icon name={page.icon} size={ICON_SIZE.sm} />
      ) : undefined,
    })),
  ];
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SegmentedTabBar
        presentation="plain"
        iconPlacement="leading"
        segmentSizing="content"
        tabs={tabs}
        activeTabId="chat"
        onSelectTab={ignoreSelect}
        testIDPrefix="session-navigation-customizer.pages-preview"
      />
    </View>
  );
}

export type OpenSessionNavigationCustomizerInput = Readonly<{
  device: DetailNavigationDevice;
  /** The mounted Session's M1 inputs; each device's list resolves through the same owner. */
  detailInput: ResolveRightSidebarTabsInput;
  /** The desktop arrangement decides which Session tools are also pages. */
  arrangement: 'session' | 'editor';
  /** The opener's own device list, already resolved for what it renders (exact); the other device resolves from `detailInput`. */
  desktopItems?: readonly DetailNavigationItem[];
  phoneCatalog?: readonly SessionCockpitMobileCatalogEntry[];
  renderPhonePreview?: (
    preferences: NavigationPlacementPreferences,
  ) => React.ReactNode;
  phonePageTabs: boolean;
}>;

/** Desktop Pages / Companions and the phone's items, from the one resolved Session list. */
export function resolveSessionNavigationCustomizerSections(
  input: Omit<OpenSessionNavigationCustomizerInput, 'device' | 'phonePageTabs'>,
): Readonly<{
  desktop: readonly DetailNavigationCustomizerSection[];
  phone: readonly DetailNavigationCustomizerSection[];
}> {
  const desktopItems = input.desktopItems ?? resolveDetailNavigationItems({
    ...input.detailInput,
    presentation: 'desktop',
    arrangement: input.arrangement,
  });
  const pages = resolveSessionDesktopPages(desktopItems).map((tab) =>
    placementItem(tab, { defaultPlacement: sessionPageDefaultPlacement(tab) }),
  );
  const companions = desktopItems
    .filter((tab) => isSessionRailCompanion(tab) && !tab.hiddenInLauncher)
    .map((tab) =>
      placementItem(tab, {
        group: railGroupOf(tab),
        defaultPlacement:
          tab.defaultPlacement ??
          (tab.owner === 'plugin' ? 'overflow' : undefined),
      }),
    );
  const groupTitles = Object.fromEntries(
    Object.entries(RAIL_GROUP_TITLE_KEYS).map(([id, key]) => [id, t(key)]),
  );
  const chat = {
    id: 'chat',
    title: t('phoneNav.rail.chatPane'),
    icon: 'chat-circle' as const,
  };
  const phoneCatalog = input.phoneCatalog ?? resolveSessionCockpitMobileCatalog({
    tabs: resolveDetailNavigationItems({
      ...input.detailInput,
      presentation: 'mobile',
    }),
    terminalTabAvailable: input.detailInput.terminalTabAvailable === true,
  });
  return {
    desktop: [
      // A single page draws no strip, so there is nothing to place until another page exists.
      ...(pages.length > 0
        ? [
            {
              id: 'pages',
              address: {
                pageKind: 'session',
                device: 'desktop',
                section: 'pages',
              } as const,
              title: t('navigationPlacement.topTabs'),
              description: t('navigationPlacement.topTabsDescription'),
              items: pages,
              fixedItems: [chat],
              renderPreview: (preferences: NavigationPlacementPreferences) => (
                <PagesPreview pages={pages} preferences={preferences} />
              ),
            },
          ]
        : []),
      {
        id: 'companions',
        address: {
          pageKind: 'session',
          device: 'desktop',
          section: 'companions',
        } as const,
        title: t('navigationPlacement.rail'),
        description: t('navigationPlacement.railDescription'),
        items: companions,
        groupTitles,
      },
    ],
    phone: [
      {
        id: 'items',
        address: {
          pageKind: 'session',
          device: 'phone',
          section: 'items',
        } as const,
        title: t('navigationPlacement.phoneBar'),
        description: t('navigationPlacement.phoneBarDescription'),
        items: phoneCatalog
          .filter((entry) => entry.id !== 'chat')
          .map((entry) => ({
            ...placementItem(entry.tab as DetailNavigationItem, {
              defaultPlacement: entry.defaultPlacement,
            }),
            id: entry.id,
          })),
        fixedItems: [chat],
        placementLabels: { pinned: t('navigationPlacement.bar') },
        ...(input.renderPhonePreview
          ? { renderPreview: input.renderPhonePreview }
          : {}),
      },
    ],
  };
}

/** Session's approved lists and previews, consumed by the shared navigation presenter. */
export function resolveSessionNavigationCustomizerProps(
  input: OpenSessionNavigationCustomizerInput,
): DetailNavigationCustomizerProps {
  const sections = resolveSessionNavigationCustomizerSections(input);
  return {
    pageKind: 'session',
    pageTitle: t('navigationPlacement.contextSession'),
    device: input.device,
    desktop: sections.desktop,
    phone: sections.phone,
    phonePageTabs: input.phonePageTabs,
    testID: 'session-navigation-customizer',
  };
}

/** Session's one Customize screen, opened at the device the person stands on. */
export function openSessionNavigationCustomizer(
  input: OpenSessionNavigationCustomizerInput,
): void {
  const props = resolveSessionNavigationCustomizerProps(input);
  fireAndForget(
    import('@/components/ui/navigation/NavigationPlacementCustomizer').then(
      ({ DetailNavigationCustomizer }) => {
        Modal.show({
          component: DetailNavigationCustomizer,
          props,
        });
      },
    ),
    { tag: 'SessionNavigationCustomizer.open' },
  );
}
