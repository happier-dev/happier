import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetInstanceV1, WidgetSizeV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useHomeHubLayout } from '@/components/hub/layout/useHomeHubLayout';
import { useNewSessionEntryRouter } from '@/components/sessions/new/navigation/newSessionEntry';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { WidgetAddSurface } from './WidgetAddSurface';
import type { WidgetAddAsk, WidgetAddSection } from './widgetAddModel';
import {
    buildAccountWidgetAddSections,
    useAccountWidgetAddSections,
    type AccountWidgetAddInput,
    type AccountWidgetSurfaceLabels,
} from './accountWidgetAddSections';

const HOME_LABELS: AccountWidgetSurfaceLabels = {
    count: (count) => t('widgetAdd.countOnHome', { count }),
    get submit() { return t('widgetAdd.addToHome'); },
};

/**
 * What Add to Home offers (lab `dashboards` dbind G): the shared personal-surface gallery
 * (`buildAccountWidgetAddSections`), counted "N on Home", every add one Home layout intent through
 * the Home Artifact owner — the same operation `widgets.item.add` performs for an agent.
 */
export function buildHomeWidgetAddSections(input: Omit<AccountWidgetAddInput, 'labels'>): readonly WidgetAddSection[] {
    return buildAccountWidgetAddSections({ ...input, labels: HOME_LABELS });
}

/**
 * Ask the agent for a Home widget (lab `widget-add` wsplit A4): Home has no Session of its own, so the
 * request is drafted into a new Session through the one New Session seed owner and nothing is sent.
 * The agent then adds it with the same `widgets.item.add` this surface uses.
 */
export function buildHomeWidgetAddAsk(input: Omit<Parameters<typeof openSessionAuthoringSeed>[0], 'seed'>): WidgetAddAsk {
    const draft = t('widgetAdd.homeAskDraft');
    return {
        title: t('widgetAdd.askTitle'),
        draft,
        note: t('widgetAdd.askNote'),
        onPick: () => openSessionAuthoringSeed({ ...input, seed: { prompt: draft } }),
    };
}

/**
 * Add to Home, anchored to Home's Customize button (lab `widget-add` wsplit A): the shared Add
 * surface. Customize arranges what is on Home, this adds to it. Mounted only while open.
 */
export function HomeWidgetAddPopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    /** The Customize bar the surface centres on (see `WidgetAddSurface.regionRef`). */
    regionRef?: React.RefObject<View | null>;
    onRequestClose: () => void;
    /** Adds into this group (a group's empty slot) instead of at the end of Home. */
    groupId?: string;
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
        // Count visible copies, including group children. Hidden copies remain restorable in Sections.
        () => layout.sections.flatMap((section) => section.hidden ? [] : (section.kind === 'widget' ? [section.instance]
            : section.kind === 'group' ? section.children.map(child => child.instance) : [])),
        [layout.sections],
    );
    const groupId = props.groupId;
    const { addInstance: addToHome } = layout;
    const addInstance = React.useCallback((instance: WidgetInstanceV1, size?: WidgetSizeV1) => addToHome(instance, size, groupId), [addToHome, groupId]);
    const { sections, pendingSections } = useAccountWidgetAddSections({ scope, instances, addInstance, labels: HOME_LABELS, testID: props.testID });
    const router = useNewSessionEntryRouter();
    const ask = React.useMemo(() => {
        const lifetime = account ? captureActiveServerAccountScopeLifetime() : null;
        return lifetime ? buildHomeWidgetAddAsk({ scope: lifetime.scope, isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => {
                const result = runGuardedNavigation(() => router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) } as never));
                if (result !== true) fireAndForget(result, { tag: 'HomeWidgetAddPopover.ask' });
            } }) : null;
    }, [account, router]);

    return (
        <WidgetAddSurface
            open
            anchorRef={props.anchorRef}
            {...(props.regionRef ? { regionRef: props.regionRef } : {})}
            onRequestClose={props.onRequestClose}
            title={t('widgetAdd.homeTitle')}
            hint={t('widgetAdd.homeHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            addLabel={t('widgetAdd.addToHome')}
            sections={sections}
            pendingSections={pendingSections}
            {...(ask ? { ask } : {})}
            {...(scope ? { serverId: scope.serverId } : {})}
            testID={props.testID}
        />
    );
}
