import {
    createComposerTextStore,
    useComposerTextStore,
    useComposerTextValue,
    type ComposerTextStore,
} from '@/components/sessions/agentInput/composerTextStore';

/**
 * Live composer text for one new-session screen instance: the shared composer text store.
 *
 * The new-session screen model is a large hook tree (~370 hook slots across ~25 sub-hooks).
 * While the prompt was `React.useState` inside that tree, every keystroke re-executed the whole
 * model, rebuilt both screen-variant prop bundles, and invalidated `React.memo` on the panel.
 * The composer input subscribes with `useNewSessionPromptValue`; submit, send and draft
 * persistence read `getPrompt()`. These names are New Session's vocabulary for the one
 * implementation in `composerTextStore`.
 */
export type NewSessionPromptStore = ComposerTextStore;

export const createNewSessionPromptStore = createComposerTextStore;

/** Create the screen instance's prompt store once, seeded from the hydrated draft text. */
export const useNewSessionPromptStore = useComposerTextStore;

/** Subscribe to the live text in the leaf that renders the composer input. */
export const useNewSessionPromptValue = useComposerTextValue;
