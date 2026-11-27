import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';

import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';

import type { WalkthroughCaptionFocus } from './WalkthroughCaptions';
import type { WalkthroughReading, WalkthroughLetteredCaption } from './walkthroughReading';

const SHOW_CAPTION = 'walkthrough.caption.show';
const PREVIOUS_CAPTION = 'walkthrough.caption.previous';
const NEXT_CAPTION = 'walkthrough.caption.next';

export function useWalkthroughCaptionCommands(
    focus: WalkthroughCaptionFocus,
    captions: WalkthroughReading['captionsByPath'] | null,
    focusKey: (path: string, caption?: WalkthroughLetteredCaption) => string | null = (path) => path,
): void {
    function step(input: PluginUiJsonValueV1 | undefined, delta: -1 | 1): boolean {
        if (!isJsonObject(input) || typeof input.path !== 'string') return false;
        const key = focusKey(input.path);
        return key !== null && focus.step(key, delta);
    }

    useCurrentUiContextLocalCommands(captions?.size ? [{
        key: SHOW_CAPTION,
        title: t('walkthrough.explain.showCaption'),
        description: `${SHOW_CAPTION} — Bring a line caption into view and keep its callout open, with {path: string, letter: string} as shown on its marker.`,
        invoke(input) {
            if (!isJsonObject(input) || typeof input.path !== 'string' || typeof input.letter !== 'string') return false;
            const caption = captions.get(input.path)?.find((entry) => entry.letter === input.letter);
            if (!caption) return false;
            const key = focusKey(input.path, caption);
            return key !== null && focus.reveal(key, caption.key);
        },
    }, {
        key: PREVIOUS_CAPTION,
        title: t('walkthrough.explain.previousCaption'),
        description: `${PREVIOUS_CAPTION} — Focus the previous line caption for {path: string} in the current view.`,
        invoke: (input) => step(input, -1),
    }, {
        key: NEXT_CAPTION,
        title: t('walkthrough.explain.nextCaption'),
        description: `${NEXT_CAPTION} — Focus the next line caption for {path: string} in the current view.`,
        invoke: (input) => step(input, 1),
    }] : []);
}
