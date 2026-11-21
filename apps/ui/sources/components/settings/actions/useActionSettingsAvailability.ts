import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';

import type { ActionSettingsAvailability } from './buildActionSettingsEntries';

/** The feature and privacy facts that decide which Actions the Account's Action catalog lists. */
export function useActionSettingsAvailability(): ActionSettingsAvailability {
    const voice = useSetting('voice') as Readonly<{ privacy?: { shareDeviceInventory?: boolean } }> | null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const shareDeviceInventory = voice?.privacy?.shareDeviceInventory !== false;
    return React.useMemo(() => ({
        executionRunsEnabled,
        memorySearchEnabled,
        voiceEnabled,
        sessionHandoffEnabled,
        voiceShareDeviceInventory: shareDeviceInventory,
    }), [executionRunsEnabled, memorySearchEnabled, shareDeviceInventory, voiceEnabled, sessionHandoffEnabled]);
}
