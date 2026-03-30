import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { AddMachineEntryItem } from './AddMachineEntryItem';
import { MachineSetupEntryItem } from './MachineSetupEntryItem';

export const MachineSetupActionsSection = React.memo(function MachineSetupActionsSection() {
    return (
        <ItemGroup>
            <MachineSetupEntryItem />
            <AddMachineEntryItem />
        </ItemGroup>
    );
});
