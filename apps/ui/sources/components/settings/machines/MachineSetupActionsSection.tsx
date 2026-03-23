import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { MachineSetupEntryItem } from './MachineSetupEntryItem';

export const MachineSetupActionsSection = React.memo(function MachineSetupActionsSection() {
    return (
        <ItemGroup>
            <MachineSetupEntryItem />
        </ItemGroup>
    );
});
