import { createContext, useContext, useLayoutEffect, useRef } from 'react';

import type { WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';

/** The opening host supplies this channel only while it has a replica to update. */
export const FirstOpenWelcomeModelContext = createContext<((model: WelcomeEntryViewModel) => void) | null>(null);

/** Shared phase for the real Welcome and the replica during the native hand-off. */
export const FirstOpenWelcomeEpoch = createContext<number | null>(null);

/** The opening surface supplies the Welcome backing while it paints this window. */
export const FirstOpenOwnsWelcomePaint = createContext(false);

export function usePublishFirstOpenWelcomeModel(model: WelcomeEntryViewModel | null): void {
    const publish = useContext(FirstOpenWelcomeModelContext);
    const previous = useRef<{ publish: typeof publish; serialized: string } | null>(null);

    useLayoutEffect(() => {
        if (!publish || !model) {
            previous.current = null;
            return;
        }
        const serialized = JSON.stringify(model);
        if (previous.current?.publish === publish && previous.current.serialized === serialized) return;
        previous.current = { publish, serialized };
        publish(model);
    }, [model, publish]);
}
