import React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export function ExistingSessionAutomationUnavailableNotice(props: Readonly<{
    reason: string;
}>): React.JSX.Element {
    const { theme } = useUnistyles();

    return (
        <ItemGroup title={t('automations.create.unavailableGroupTitle')}>
            <Item
                title={t('automations.create.cannotCreateForSession')}
                subtitle={props.reason}
                subtitleLines={0}
                icon={<Icon name="warning-circle" size={29} color={theme.colors.state.danger.foreground} />}
                showChevron={false}
            />
        </ItemGroup>
    );
}
