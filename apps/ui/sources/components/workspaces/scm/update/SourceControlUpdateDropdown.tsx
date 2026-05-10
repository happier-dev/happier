import * as React from 'react';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

export function SourceControlUpdateDropdown(props: Readonly<{
    testID: string;
    title: string;
    items: ReadonlyArray<DropdownMenuItem>;
    selectedId: string;
    disabled?: boolean;
    onSelect: (id: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);

    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            items={props.items}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            itemTrigger={{
                title: props.title,
                itemProps: {
                    testID: props.testID,
                    disabled: props.disabled,
                },
            }}
        />
    );
}
