import * as React from 'react';

import type { MemorySettingsV1} from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';

import { Switch } from '@/components/ui/forms/Switch';
import {
    resolveArchivedMemoryEligibilityControl,
    type ArchivedMemoryStatusRequestState,
} from '@/sync/domains/memory/resolveArchivedMemoryEligibilityControl';
import { t } from '@/text';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';

/**
 * Opt-in archived eligibility for daemon-local memory.
 *
 * The control is enabled only when the daemon advertises that it implements
 * the setting, and it shows the eligibility the daemon actually applies. An
 * older daemon echoes the stored setting while ignoring it, so this surface
 * says "update needed" rather than pretending the change took effect.
 */
export const MemorySettingsArchivedRow = React.memo(function MemorySettingsArchivedRow(props: Readonly<{
    settings: MemorySettingsV1;
    status: MemoryStatusV1 | null;
    statusRequestState: ArchivedMemoryStatusRequestState;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
    /** Set by the enclosing `ItemGroup`. */
    showDivider?: boolean;
}>) {
    const control = resolveArchivedMemoryEligibilityControl({
        status: props.status,
        statusRequestState: props.statusRequestState,
    });

    const unavailableCopy = control.state === 'loading'
        ? t('common.loading')
        : control.state === 'unreachable'
            ? t('common.unavailable')
            : t('memorySearchSettings.archived.unsupportedSubtitle');

    return (
        <SettingRow
            testID="memory-settings-include-archived-item"
            setting={MEMORY_SETTINGS.settings.include}
            showDivider={props.showDivider}
            subtitle={control.supported
                ? t('memorySearchSettings.archived.includeSubtitle')
                : unavailableCopy}
            subtitleLines={0}
            rightElement={(
                <Switch
                    testID="memory-settings-include-archived"
                    value={control.value}
                    disabled={!control.supported}
                    onValueChange={(value) => {
                        if (!control.supported) return;
                        void props.writeSettings({
                            ...props.settings,
                            includeArchivedSessions: Boolean(value),
                        });
                    }}
                />
            )}
            showChevron={false}
        />
    );
});
