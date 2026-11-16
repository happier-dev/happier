import * as React from 'react';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import { followSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const ALWAYS_ACTIVE = Object.freeze({ get: () => true, subscribe: () => () => {} });

/** The mounted composer's pushed draft fact withdraws each warning through the existing Keep Action. */
export function useSessionGuardDraftActivity(input: Readonly<{
    textStore: ComposerTextStore;
    warningKey: string | null;
    /** The composer's focus, followed by subscription: only a focused composer's typing keeps work running. */
    active?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
    keepRunning(): void;
}>): void {
    const { textStore, warningKey, keepRunning } = input;
    const active = input.active ?? ALWAYS_ACTIVE;
    const keptWarning = React.useRef<string | null>(null);
    React.useEffect(() => followSignal(active, (isActive) => {
        if (!isActive || !warningKey || keptWarning.current === warningKey) return;
        // A warning is the coalescing boundary: one Action for the whole typing
        // gesture, even while its acknowledgement/metadata push is in flight.
        const release = textStore.subscribe(() => {
            keptWarning.current = warningKey;
            release();
            keepRunning();
        });
        return release;
    }), [active, textStore, warningKey, keepRunning]);
}
