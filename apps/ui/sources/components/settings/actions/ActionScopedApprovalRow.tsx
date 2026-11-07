import * as React from 'react';

import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

export type ActionScopedApprovalMode = 'default' | 'ask_first' | 'allowed';

/**
 * One scoped approval preference (a Machine today, an Environment later): Default follows the setting
 * above, Ask first and Allowed override it for this one scope. The caller resolves the value through
 * the Settings control-state owner and writes the choice through `actions.policy.set`.
 */
export const ActionScopedApprovalRow = React.memo(function ActionScopedApprovalRow(props: Readonly<{
    testIDPrefix: string;
    title: string;
    subtitle?: string;
    icon?: React.ReactNode;
    value: ActionScopedApprovalMode;
    disabled?: boolean;
    onChange: (mode: ActionScopedApprovalMode) => void;
    /** Injected by `ItemGroup`, which owns the section's row dividers. */
    showDivider?: boolean;
}>) {
    const options = React.useMemo(() => [
        { id: 'default' as const, label: t('settingsActions.scopedMachines.default') },
        { id: 'ask_first' as const, label: t('settingsActions.modes.askFirst') },
        { id: 'allowed' as const, label: t('settingsActions.modes.allowed') },
    ], []);
    return (
        <SegmentedChoiceItem
            testID={props.testIDPrefix}
            testIDPrefix={`${props.testIDPrefix}:mode`}
            title={props.title}
            subtitle={props.subtitle}
            icon={props.icon}
            options={options}
            value={props.value}
            valueSource={props.value === 'default' ? 'inherited' : 'set'}
            onChange={props.onChange}
            disabled={props.disabled}
            accessoryLayout="adaptive"
            showDivider={props.showDivider}
        />
    );
});
