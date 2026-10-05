import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useHomeHubLayout } from '@/components/hub/layout/useHomeHubLayout';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { WidgetAddPopover } from './WidgetAddPopover';
import type { WidgetAddSection } from './widgetAddModel';
import {
    buildAccountWidgetAddSections,
    useAccountWidgetAddSections,
    type AccountWidgetAddInput,
    type AccountWidgetSurfaceLabels,
} from './accountWidgetAddSections';

const HOME_LABELS: AccountWidgetSurfaceLabels = {
    count: (count) => t('widgetAdd.countOnHome', { count }),
    get submit() { return t('widgetAdd.addToHome'); },
    get fromPluginsHint() { return t('widgetAdd.homeFromPluginsHint'); },
};

/**
 * What Add to Home offers (lab `dashboards` dbind G): the shared personal-surface gallery
 * (`buildAccountWidgetAddSections`), counted "N on Home", every add one Home layout intent through
 * the Home Artifact owner — the same operation `widgets.instance.add` performs for an agent.
 */
export function buildHomeWidgetAddSections(input: Omit<AccountWidgetAddInput, 'labels'>): readonly WidgetAddSection[] {
    return buildAccountWidgetAddSections({ ...input, labels: HOME_LABELS });
}

/**
 * Add to Home, anchored to Home's Customize button (lab dbind G / dadd A): the shared Gallery | List
 * popover and its Set up step. It replaces Customize's former "available widgets" rows: Customize
 * arranges what is on Home, this adds to it. Mounted only while open.
 */
export function HomeWidgetAddPopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    testID: string;
}>): React.ReactElement | null {
    if (!props.open) return null;
    return <OpenHomeWidgetAddPopover {...props} />;
}

function OpenHomeWidgetAddPopover(props: React.ComponentProps<typeof HomeWidgetAddPopover>): React.ReactElement {
    const account = useActiveServerAccountScope();
    const layout = useHomeHubLayout();
    const scope = React.useMemo<WidgetSurfaceRefV1 | null>(() => (
        account ? { serverId: account.serverId, accountId: account.accountId, owner: { kind: 'home' } } : null
    ), [account]);
    const instances = React.useMemo(
        () => layout.sections.flatMap((section) => (section.kind === 'widget' ? [section.instance] : [])),
        [layout.sections],
    );
    const sections = useAccountWidgetAddSections({ scope, instances, addInstance: layout.addInstance, labels: HOME_LABELS, testID: props.testID });

    return (
        <WidgetAddPopover
            open
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            title={t('widgetAdd.homeTitle')}
            hint={t('widgetAdd.homeHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            sections={sections}
            {...(scope ? { serverId: scope.serverId } : {})}
            testID={props.testID}
        />
    );
}
