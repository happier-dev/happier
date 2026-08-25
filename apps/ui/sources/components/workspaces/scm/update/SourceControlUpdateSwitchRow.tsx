import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { Typography } from '@/constants/Typography';

import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';

/**
 * Kept as a named export because the update tab's call sites pass the narrowed `theme` prop, but it
 * is no longer a second implementation: the same label + accessory row as every other list row,
 * through the canonical owner, with the injected theme still winning where it differs. This mirrors
 * {@link SourceControlUpdateButton}, which stopped being its own button the same way.
 *
 * Going through `Item` is also what gives the switch its accessible name. A label that merely sits
 * next to a control names nothing — the row has no role for the name to attach to — so this row
 * used to announce as a bare "switch". `Item` publishes its title into the accessory slot and the
 * `Switch` falls back to it, which is the one place that decision is made for every row in the app.
 *
 * The box is pinned back to the original metrics (no padding, 38pt tall) so the update tab's dense
 * panel keeps its rhythm; `Item`'s own compact padding is meant for a full-width settings list.
 */
export function SourceControlUpdateSwitchRow(props: Readonly<{
    theme: SourceControlUpdateTheme;
    testID: string;
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
}>) {
    return (
        <Item
            testID={props.testID}
            mode="info"
            density="compact"
            showDivider={false}
            title={props.label}
            titleStyle={{
                fontSize: 12,
                color: props.theme.colors.text.primary,
                ...Typography.default('semiBold'),
            }}
            style={{ minHeight: 38, paddingHorizontal: 0, paddingVertical: 0 }}
            rightElement={(
                <Switch
                    compact
                    value={props.value}
                    disabled={props.disabled}
                    onValueChange={props.onValueChange}
                />
            )}
        />
    );
}
