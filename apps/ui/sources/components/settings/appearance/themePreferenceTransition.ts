import type { ColorSchemeName, PlatformOSType } from 'react-native';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';

import { commitWebThemeMutation } from './commitWebThemeMutation';
import {
    THEME_TRANSITION_DURATION_MS,
    THEME_TRANSITION_EASING,
} from './themePreferenceTransitionMotion';

export type ThemeTransitionPlatform = PlatformOSType | 'web';

export type NativeThemePreferenceTransitionController = {
    run: (mutation: () => void) => Promise<void> | void;
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

let registeredNativeController: NativeThemePreferenceTransitionController | null = null;

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
        if (!documentLike || typeof startViewTransition !== 'function' || typeof animate !== 'function') {
            input.mutation();
            return;
        }

        const commitMutation = input.webMutationCommit ?? commitWebThemeMutation;
        const transition = startViewTransition.call(documentLike, () => commitMutation(input.mutation));
        await transition.ready;
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
    try {
        await nativeController.run(() => {
            didMutate = true;
            input.mutation();
        });
    } catch {
        if (!didMutate) {
            input.mutation();
        }
    }
}
