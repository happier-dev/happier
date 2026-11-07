import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionSpaceIcon } from '@/components/ui/lists/collection/CollectionSpaceIcon';
import type { EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { t } from '@/text';
import { SettingsReorderList } from './SettingsReorderList';

type SpaceRow = Readonly<{ id: string; name: string; icon: React.ComponentProps<typeof CollectionSpaceIcon>['icon'] }>;

/** The Manage spaces page's list presentation; editing and persistence stay with their existing owners. */
export function CollectionSpacesSettingsList(props: Readonly<{
    spaces: readonly SpaceRow[];
    reorder: EntityFlatReorderBinding;
    header: React.ReactNode;
    editingId: string | null;
    anchorRef: React.RefObject<View | null>;
    onEdit(id: string): void;
    wrapSpaces(children: React.ReactElement): React.ReactElement;
    overlay?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return <SettingsReorderList testID="collection-spaces-settings" items={props.spaces} reorder={props.reorder}
        header={props.header} retainedId={props.editingId} wrapItems={props.wrapSpaces} overlay={props.overlay}
        renderRow={(space, renderHandle) => <View ref={space.id === props.editingId ? props.anchorRef : undefined} collapsable={false}>
            <Item testID={`collection-spaces-settings:${space.id}`} title={space.name}
                leftElement={<View style={LEADING_STYLE}>
                    {renderHandle(`collection-spaces-settings.move:${space.id}`)}
                    <CollectionSpaceIcon icon={space.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
                </View>}
                showChevron={false}
                rightElement={<IconButton testID={`collection-spaces-settings.edit:${space.id}`}
                    accessibilityLabel={t('sessionsList.spacesEditNamed', { name: space.name })}
                    tooltip={t('sessionsList.spacesEdit')} variant="plain" iconName="pencil-simple" iconSize={ICON_SIZE.sm}
                    onPress={() => props.onEdit(space.id)} />}
            />
        </View>} />;
}

const LEADING_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;
