import * as React from 'react';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import type { ConnectedServicesIndexModel, ConnectedServicesIndexSheet } from '../model/buildConnectedServicesIndexModel';

/** The services a new pool can be made for: agent services with at least one V4 account. */
export function selectNewPoolServices(model: ConnectedServicesIndexModel): readonly ConnectedServicesIndexSheet[] {
    return model.sheets.filter((sheet) => (
        sheet.section === 'agents'
        && sheet.canAdd
        && sheet.accounts.some((account) => account.kind === 'qualified')
    ));
}

/**
 * "New pool" (the rail's Pools "+", the index's Pools action). Pools belong to one service, so with
 * several services the trigger opens a menu of them; with one it starts that service's pool at once.
 */
export const NewPoolMenu = React.memo(function NewPoolMenu(props: Readonly<{
    services: readonly ConnectedServicesIndexSheet[];
    onCreate: (sheet: ConnectedServicesIndexSheet) => void;
    renderTrigger: (onPress: () => void) => React.ReactElement;
    testID?: string;
}>) {
    const [open, setOpen] = React.useState(false);
    const { services, onCreate } = props;
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => services.map((sheet) => ({
        id: sheet.serviceKey,
        title: sheet.label,
        icon: <ConnectedServiceMark legacyServiceId={sheet.legacyServiceId} size="inline" />,
    })), [services]);
    if (services.length === 0) return null;
    if (services.length === 1) return props.renderTrigger(() => onCreate(services[0]!));
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={(serviceKey) => {
                setOpen(false);
                const sheet = services.find((candidate) => candidate.serviceKey === serviceKey);
                if (sheet) onCreate(sheet);
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={260}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => props.renderTrigger(toggle)}
        />
    );
});
