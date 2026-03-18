import React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import type { ExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/sessionAuthoringContext';
import { t } from '@/text';

export function ExistingSessionAutomationContextSection(props: Readonly<{
    context: ExistingSessionAutomationAuthoringContext;
}>): React.JSX.Element | null {
    const composerState = resolveSessionComposerStateFromAuthoringContext(props.context);
    const rows: React.JSX.Element[] = [];

    if (composerState.machineName) {
        rows.push(
            <Item
                key="machine"
                title={t('common.machine')}
                subtitle={composerState.machineName}
                showChevron={false}
            />,
        );
    }

    if (composerState.currentPath) {
        rows.push(
            <Item
                key="path"
                title={t('common.path')}
                subtitle={composerState.currentPath}
                showChevron={false}
            />,
        );
    }

    if (composerState.profileId) {
        rows.push(
            <Item
                key="profile"
                title={t('profiles.title')}
                subtitle={composerState.profileId}
                showChevron={false}
            />,
        );
    }

    if (rows.length === 0) {
        return null;
    }

    return (
        <ItemGroup title={t('common.details')}>
            {rows}
        </ItemGroup>
    );
}
