import * as React from 'react';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { memberDefaultsSummary } from './memberDefaults';

/**
 * "Defaults for members" as one destination row: what the layer sets, then the editor one press
 * away. The Home's Teams page and a Team's Settings both link to their editor through this row, so
 * the Machine and per-Agent rows never stand between those pages and their own content.
 */
export const MemberDefaultsSummaryRow = React.memo(function MemberDefaultsSummaryRow(
    props: Readonly<{
        testID: string;
        defaults: ManagedSessionDefaultsV1;
        /** The section the row sits in, when the page groups it under one. */
        sectionTitle?: string;
        onPress: () => void;
    }>,
) {
    const summary = memberDefaultsSummary(props.defaults);
    const parts = [
        summary.machine ? t('teams.settings.memberDefaults.machine') : null,
        summary.agents > 0 ? t('teams.settings.memberDefaults.summaryAgents', { count: summary.agents }) : null,
    ].filter((part): part is string => part !== null);
    return (
        <ItemGroup title={props.sectionTitle}>
            <Item
                testID={props.testID}
                icon={<Icon name="sliders-horizontal" />}
                title={t('teams.settings.memberDefaults.title')}
                subtitle={parts.length > 0 ? parts.join(' · ') : t('teams.settings.memberDefaults.summaryNone')}
                onPress={props.onPress}
            />
        </ItemGroup>
    );
});
