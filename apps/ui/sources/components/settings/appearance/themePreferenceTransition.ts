import type { ColorSchemeName, PlatformOSType } from 'react-native';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';

import { commitWebThemeMutation } from './commitWebThemeMutation';
import {
    THEME_TRANSITION_DURATION_MS,
    THEME_TRANSITION_EASING,
} from './themePreferenceTransitionMotion';

export type ThemeTransitionPlatform = PlatformOSType | 'web';

export type NativeThemePreferenceTransitionController = {
    run: (mutation: () => void, direction?: 'sunrise' | 'night') => Promise<void> | void;
};

export type ThemePreferenceChangeInput = {
    currentPreference: ThemePreference;
    document?: Document;
    mutation: () => void;
    nativeController?: NativeThemePreferenceTransitionController | null;
    nextPreference: ThemePreference;
    platform: ThemeTransitionPlatform;
    reduceMotion: boolean;
    forceAnimate?: boolean;
    systemTheme: ColorSchemeName;
    webMutationCommit?: (mutation: () => void) => Promise<void> | void;
};

/**
 * A web reveal other than the default wipe (the atmosphere's Horizon theme switch). `prepare` runs before
 * the old view is captured, so anything it adds to the page exists in both captures; the returned
 * `play` receives the transition at once and owns its reveal from `ready` (and its cleanup, even when
 * the transition is skipped). Returning null keeps the wipe.
 */
export type WebThemePreferenceChoreography = {
    prepare: (document: Document, direction: 'sunrise' | 'night') => ((transition: ViewTransition) => void) | null;
};

let registeredNativeController: NativeThemePreferenceTransitionController | null = null;
let registeredWebChoreography: WebThemePreferenceChoreography | null = null;

export function registerWebThemePreferenceChoreography(choreography: WebThemePreferenceChoreography): () => void {
    registeredWebChoreography = choreography;
    return () => {
        if (registeredWebChoreography === choreography) {
            registeredWebChoreography = null;
        }
    };
}

function resolveVisualTheme(preference: ThemePreference, systemTheme: ColorSchemeName): 'dark' | 'light' {
    if (preference === 'adaptive') {
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return preference;
}

export function registerNativeThemePreferenceTransitionController(
    controller: NativeThemePreferenceTransitionController,
): () => void {
    registeredNativeController = controller;
    return () => {
        if (registeredNativeController === controller) {
            registeredNativeController = null;
        }
    };
}

export function shouldAnimateThemePreferenceChange(
    input: Omit<ThemePreferenceChangeInput, 'document' | 'mutation' | 'nativeController'>,
): boolean {
    if (input.reduceMotion) return false;
    if (input.forceAnimate) return true;
    return resolveVisualTheme(input.currentPreference, input.systemTheme)
        !== resolveVisualTheme(input.nextPreference, input.systemTheme);
}

export async function runThemePreferenceChange(input: ThemePreferenceChangeInput): Promise<void> {
    if (!shouldAnimateThemePreferenceChange(input)) {
        input.mutation();
        return;
    }

    if (input.platform === 'web') {
        const documentLike = input.document ?? (typeof document === 'undefined' ? null : document);
        const startViewTransition = documentLike?.startViewTransition;
        const animate = documentLike?.documentElement?.animate;
        if (!documentLike || documentLike.visibilityState === 'hidden'
            || typeof startViewTransition !== 'function' || typeof animate !== 'function') {
            input.mutation();
            return;
        }

        const commitMutation = input.webMutationCommit ?? commitWebThemeMutation;
        const direction = resolveVisualTheme(input.nextPreference, input.systemTheme) === 'light' ? 'sunrise' : 'night';
        const play = registeredWebChoreography?.prepare(documentLike, direction) ?? null;
        const transition = startViewTransition.call(documentLike, () => commitMutation(input.mutation));
        if (play) {
            play(transition);
        }
        try {
            await transition.ready;
        } catch {
            // Hidden/superseded transitions skip their reveal, but still run the update once.
            // Keep mutation failures observable without replaying an already-applied change.
            await transition.updateCallbackDone;
            return;
        }
        if (play) return;
        animate.call(
            documentLike.documentElement,
            { clipPath: ['inset(0 0 100% 0)', 'inset(0)'] },
            {
                duration: THEME_TRANSITION_DURATION_MS,
                easing: THEME_TRANSITION_EASING,
                fill: 'both',
                pseudoElement: '::view-transition-new(root)',
            },
        );
        return;
    }

    const nativeController = input.nativeController ?? registeredNativeController;
    if (!nativeController) {
        input.mutation();
        return;
    }

    let didMutate = false;
    let mutationFailed = false;
    let mutationError: unknown;
    try {
        await nativeController.run(() => {
            didMutate = true;
            try {
                input.mutation();
            } catch (error) {
                mutationFailed = true;
                mutationError = error;
                throw error;
            }
        }, resolveVisualTheme(input.nextPreference, input.systemTheme) === 'light' ? 'sunrise' : 'night');
    } catch {
        if (mutationFailed) throw mutationError;
        if (!didMutate) {
            input.mutation();
        }
    }
}
