import * as React from 'react';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';

/** The mounted composer's pushed draft fact withdraws each warning through the existing Keep Action. */
export function useSessionGuardDraftActivity(input: Readonly<{
    textStore: ComposerTextStore;
    warningKey: string | null;
    keepRunning(): void;
}>): void {
    const { textStore, warningKey, keepRunning } = input;
    const keptWarning = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!warningKey || keptWarning.current === warningKey) return;
        // A warning is the coalescing boundary: one Action for the whole typing
        // gesture, even while its acknowledgement/metadata push is in flight.
        const release = textStore.subscribe(() => {
            keptWarning.current = warningKey;
            release();
            keepRunning();
        });
        return release;
    }, [textStore, warningKey, keepRunning]);
}
