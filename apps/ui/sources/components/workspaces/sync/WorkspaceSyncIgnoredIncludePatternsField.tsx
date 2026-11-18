import * as React from 'react';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

/**
 * The ignored-file patterns a transfer includes, as a row with its field beneath the label, for a form
 * that owns the draft and submits it itself (workspace activation). A setting that saves on its own
 * uses `FieldValueItem` instead.
 */
export function WorkspaceSyncIgnoredIncludePatternsField(props: Readonly<{
    value: string;
    onChangeText: (value: string) => void;
    /** Leaving the field: a host that saves on its own takes the patterns here. */
    onEndEditing?: () => void;
    editable?: boolean;
    showDivider?: boolean;
}>) {
    const label = t('settingsSession.handoff.includeIgnoredMode.globsTitle');
    return (
        <Item
            title={label}
            accessoryLayout="stacked"
            showChevron={false}
            showDivider={props.showDivider}
            rightElement={(
                <FieldTextInput
                    accessibilityLabel={label}
                    value={props.value}
                    onChangeText={props.onChangeText}
                    onBlur={props.onEndEditing}
                    placeholder={t('settingsSession.handoff.includeIgnoredMode.globsPlaceholder')}
                    monospace
                    editable={props.editable}
                />
            )}
        />
    );
}
