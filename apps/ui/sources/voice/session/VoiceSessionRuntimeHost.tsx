import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { useVoiceProviderRuntimeDemand } from './useVoiceProviderRuntimeDemand';

const Runtime = retryableLazy(async () => {
    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    return { default: VoiceSessionRuntime };
});

/** Discovery stays synchronous; executable adapters are needed only after Voice is enabled. */
export function VoiceSessionRuntimeHost(): React.ReactElement | null {
    const demanded = useVoiceProviderRuntimeDemand().size > 0;
    const activated = React.useRef(false);
    activated.current ||= demanded;
    // Keep the one lifecycle owner mounted after activation: turning Voice off or
    // switching Accounts still needs its existing retirement and media cleanup.
    if (!activated.current) return null;
    return <React.Suspense fallback={null}><Runtime /></React.Suspense>;
}
