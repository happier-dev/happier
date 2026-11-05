import { resolveDetailPhoneNavigationItem, type DetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { t } from '@/text';
import { DISCUSSION_DESKTOP_NAVIGATION_ADDRESS, DISCUSSION_PHONE_NAVIGATION_ADDRESS } from './discussionNavigation';

/** Rail and phone lend the same admitted Discussion list to the shared Desktop/Phone editor. */
export function resolveDiscussionNavigationCustomizer(input: Readonly<{
    items: readonly DetailNavigationItem[];
    device: 'desktop' | 'phone';
}>): DetailNavigationCustomizerProps {
    return {
        pageKind: 'discussion', pageTitle: t('session.collaboration.conversations'), device: input.device,
        desktop: [{ id: 'companions', address: DISCUSSION_DESKTOP_NAVIGATION_ADDRESS,
            title: t('navigationPlacement.rail'), description: t('navigationPlacement.railDescription'),
            items: input.items.filter(item => item.navigation.kind !== 'page').map(item => ({ ...item,
                title: getRightSidebarTabLabel(item) })),
        }],
        phone: [{ id: 'items', address: DISCUSSION_PHONE_NAVIGATION_ADDRESS,
            title: t('navigationPlacement.phoneBar'), description: t('navigationPlacement.phoneBarDescription'),
            items: input.items.filter(item => item.phonePlacement !== 'none').map(item => ({ ...item,
                title: getRightSidebarTabLabel(item) })).map(resolveDetailPhoneNavigationItem),
            placementLabels: { pinned: t('navigationPlacement.bar') },
        }],
        phonePageTabs: true, testID: 'discussion-navigation-customizer',
    };
}
