import * as React from 'react';

import { DropdownMenu, type DropdownMenuItem, type DropdownMenuProps } from '@/components/ui/forms/dropdown/DropdownMenu';

export type ContextMenuItem = DropdownMenuItem;

export type ContextMenuProps = Omit<DropdownMenuProps, 'trigger' | 'itemTrigger' | 'popoverAnchorRef'> & Readonly<{
    anchorRef: React.RefObject<unknown>;
}>;

export function ContextMenu(props: ContextMenuProps) {
    const { anchorRef, ...rest } = props;
    if (rest.open !== true) return null;
    return (
        <DropdownMenu
            {...rest}
            trigger={null}
            popoverAnchorRef={anchorRef}
            matchTriggerWidth={false}
            connectToTrigger={false}
            popoverAnchorAlign="center"
            popoverAnchorAlignVertical="center"
            overlayArrow={true}
            allowEmptySelection={true}
        />
    );
}
