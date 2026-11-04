import * as React from 'react';
import type { SessionSpaceMembershipSetInputV1 } from '@happier-dev/protocol/actions';
import type { CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { resolveCollectionSpaceIconName } from '@/components/ui/lists/collection/CollectionSpacesStrip';
import { t } from '@/text';

export type SessionSpaceMembershipMenuChoice = Pick<SessionSpaceMembershipSetInputV1, 'operation' | 'spaceId' | 'sourceSpaceId'>;
export type SessionSpaceMembershipMenu = Readonly<{
    items: readonly DropdownMenuItem[];
    choices: ReadonlyMap<string, SessionSpaceMembershipMenuChoice>;
}>;

/** Display only: the catalog and Action own membership, qualification and admission. */
export function buildSessionSpaceMembershipMenu(
    spaces: readonly (Pick<CollectionSpaceV1<'sessionWork'>, 'id' | 'name' | 'membership'> & Partial<Pick<CollectionSpaceV1<'sessionWork'>, 'icon'>>)[],
    /** The row menu's icon colour: actions and spaces take the menu's leading icon column, spaces with their own glyph. */
    iconColor?: string,
): SessionSpaceMembershipMenu {
    const glyph = (name: IconName) => iconColor === undefined ? {} : { icon: React.createElement(Icon, { name, size: 16, color: iconColor }) };
    const spaceGlyph = (space: (typeof spaces)[number]) => space.icon ? glyph(resolveCollectionSpaceIconName(space.icon)) : {};
    const choices = new Map<string, SessionSpaceMembershipMenuChoice>();
    const add = spaces.map((space, index): DropdownMenuItem => {
        const id = `space-membership:add:${index}`;
        choices.set(id, { operation: 'add', spaceId: space.id });
        return { id, title: space.name, ...spaceGlyph(space) };
    });
    const move = spaces.flatMap((source, sourceIndex): DropdownMenuItem[] => {
        const destinations = spaces.flatMap((destination, destinationIndex): DropdownMenuItem[] => {
            if (source.id === destination.id) return [];
            const id = `space-membership:move:${sourceIndex}:${destinationIndex}`;
            choices.set(id, { operation: 'move', spaceId: destination.id, sourceSpaceId: source.id });
            return [{ id, title: destination.name, ...spaceGlyph(destination) }];
        });
        return destinations.length ? [{ id: `space-membership:source:${sourceIndex}`, title: source.name, ...spaceGlyph(source),
            ...(source.membership?.mode === 'manual_only' ? {} : { subtitle: t('sessionsList.spacesMembershipSmartMayRemain') }),
            submenu: { items: destinations } }] : [];
    });
    const remove = spaces.map((space, index): DropdownMenuItem => {
        const id = `space-membership:remove:${index}`;
        choices.set(id, { operation: 'remove', spaceId: space.id });
        return { id, title: space.name, ...spaceGlyph(space),
            ...(space.membership?.mode === 'manual_only' ? {} : { subtitle: t('sessionsList.spacesMembershipSmartMayRemain') }) };
    });
    return { choices, items: [
        ...(add.length ? [{ id: 'space-membership:add', title: t('sessionsList.spacesMembershipAddTo'), ...glyph('squares-four'), submenu: { items: add } }] : []),
        ...(move.length ? [{ id: 'space-membership:move', title: t('sessionsList.spacesMembershipMoveTo'), ...glyph('arrows-left-right'), submenu: { items: move } }] : []),
        ...(remove.length ? [{ id: 'space-membership:remove', title: t('sessionsList.spacesMembershipRemoveFrom'), ...glyph('minus-circle'), submenu: { items: remove } }] : []),
    ] };
}
