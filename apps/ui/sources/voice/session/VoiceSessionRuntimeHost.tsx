import * as React from 'react';

import { InboxModelProvider } from '@/hooks/inbox/useInboxModel';

import { useVoiceProviderRuntimeDemand } from './useVoiceProviderRuntimeDemand';
import { rejectVoiceSessionRuntimeRequest } from './voiceSessionLifecycleControllerStore';

/** Discovery stays synchronous; the first Start admits executable adapter loading. */
export function VoiceSessionRuntimeHost(): React.ReactElement | null {
    const demanded = useVoiceProviderRuntimeDemand().size > 0;
    const activated = React.useRef(false);
    activated.current ||= demanded;
    // Keep the one lifecycle owner mounted after activation: turning Voice off or
    // switching Accounts still needs its existing retirement and media cleanup.
    if (!activated.current) return null;
    try {
        // The bundled module stays deferred until admission. A synchronous load
        // keeps its first mount in the admitting update instead of a Suspense retry.
        const { VoiceSessionRuntime } = require('./VoiceSessionRuntime') as typeof import('./VoiceSessionRuntime');
        // Global Voice has no visible Inbox route, but its agent Action must read
        // through the same mounted Inbox owner as Home. Keep the owner as a
        // sibling so Inbox projection readiness never blocks Voice startup.
        return <>
            <InboxModelProvider>{null}</InboxModelProvider>
            <VoiceSessionRuntime />
        </>;
    } catch (error) {
        rejectVoiceSessionRuntimeRequest(error);
        throw error;
    }
}
