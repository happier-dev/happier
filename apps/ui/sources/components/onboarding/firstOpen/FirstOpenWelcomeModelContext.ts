import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import type { GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';

import type { WelcomeEntryViewModel } from '@/components/onboarding/preAuth/WelcomeEntryView';

/** Kept with the other channels so the ordinary shell does not import the opening host. */
export type FirstOpenLayoutTarget = 'shell' | 'workflow';
type OnFirstOpenLayout = (event: LayoutChangeEvent) => WelcomeEntryViewModel | undefined;
export const FirstOpenContentLayout = createContext<Readonly<{
    target: FirstOpenLayoutTarget;
    onLayout: OnFirstOpenLayout;
}> | null>(null);

export function useFirstOpenContentLayout(target: FirstOpenLayoutTarget): OnFirstOpenLayout | undefined {
    const layout = useContext(FirstOpenContentLayout);
    return layout?.target === target ? layout.onLayout : undefined;
}

/** The opening host supplies this channel only while it has a replica to update. */
export const FirstOpenWelcomeModelContext = createContext<((model: WelcomeEntryViewModel) => void) | null>(null);

/** Shared phase for the real Welcome and the replica during the native hand-off. */
export const FirstOpenWelcomeEpoch = createContext<number | null>(null);

/**
 * Present while the opening paints this window. The desktop replica draws no planet of its own; with `onPainted`,
 * the Welcome's planet paints hidden in place and reports that paint, so the scene hands off only to a painted planet.
 */
export type FirstOpenWelcomePaint = Readonly<{ onPainted?: (status: GlyphSurfaceReadiness) => void }>;
export const FirstOpenOwnsWelcomePaint = createContext<FirstOpenWelcomePaint | null>(null);

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
