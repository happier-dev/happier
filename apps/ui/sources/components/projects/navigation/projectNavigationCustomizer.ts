import { resolveDetailPhoneNavigationItem, type ProjectDetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { t } from '@/text';

export const PROJECT_PHONE_NAVIGATION_ADDRESS = { pageKind: 'project', device: 'phone', section: 'items' } as const;

/** Both openers lend the admitted Project list to the shared Desktop/Phone editor. */
export function resolveProjectNavigationCustomizer(input: Readonly<{
    items: readonly ProjectDetailNavigationItem[];
    phoneItems?: readonly ProjectDetailNavigationItem[];
    device: 'desktop' | 'phone';
}>): DetailNavigationCustomizerProps {
    return {
        pageKind: 'project', pageTitle: t('navigationPlacement.contextProject'), device: input.device,
        desktop: [{ id: 'pages', address: { pageKind: 'project', device: 'desktop', section: 'pages' },
            title: t('navigationPlacement.topTabs'), description: t('navigationPlacement.topTabsDescription'),
            items: input.items.filter(item => item.page).map(item => ({ id: item.id, title: item.title, icon: item.icon,
                defaultPlacement: item.defaultPlacement, allowedPlacements: item.allowedPlacements })),
        }, { id: 'companions', address: { pageKind: 'project', device: 'desktop', section: 'companions' },
            title: t('navigationPlacement.rail'), description: t('navigationPlacement.railDescription'),
            items: input.items.flatMap(item => item.companion ? [{ id: item.companion.id,
                title: getRightSidebarTabLabel(item.companion), icon: item.companion.icon,
                defaultPlacement: item.companion.defaultPlacement, allowedPlacements: item.companion.allowedPlacements }] : []),
        }],
        phone: [{ id: 'items', address: PROJECT_PHONE_NAVIGATION_ADDRESS, title: t('navigationPlacement.phoneBar'),
            description: t('navigationPlacement.phoneBarDescription'),
            items: input.phoneItems ?? input.items.filter(item => item.phonePlacement !== 'none').map(resolveDetailPhoneNavigationItem),
            placementLabels: { pinned: t('navigationPlacement.bar') },
        }],
        phonePageTabs: true, testID: 'project-navigation-customizer',
    };
}
