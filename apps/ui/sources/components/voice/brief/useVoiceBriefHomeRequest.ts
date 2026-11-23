import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';

import { registerVoiceBriefHomeRequest, voiceBriefOperationResult, voiceBriefUnavailable } from './voiceBriefActionRuntime';

/** Closed Home registers only its existing opener; Inbox details remain demand-mounted. */
export function useVoiceBriefHomeRequest(input: Readonly<{ available: boolean; onOpen: () => void }>): void {
    const enabled = useFeatureEnabled('voice');
    const current = React.useRef({ ...input, enabled, accountLifetime: captureActiveServerAccountScopeCurrentness() });
    current.current = { ...input, enabled, accountLifetime: captureActiveServerAccountScopeCurrentness() };
    React.useLayoutEffect(() => {
        if (!input.available || enabled !== true) return;
        return registerVoiceBriefHomeRequest(() => {
            const owner = current.current;
            if (!owner.available || owner.enabled !== true || !owner.accountLifetime.isCurrent()) {
                return voiceBriefUnavailable('ui.voice_global.brief.account_scope');
            }
            owner.onOpen();
            return voiceBriefOperationResult('waiting');
        });
    }, [input.available, enabled]);
}
