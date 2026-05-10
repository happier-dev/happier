import type { ThemeChoice } from './useTheme';

const THEME_TRANSITION_DURATION_MS = 600;
const THEME_TRANSITION_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

type ViewTransitionDocument = Document & {
    startViewTransition?: (updateCallback: () => void) => {
        ready: Promise<void>;
    };
};

export type ThemeTransitionInput = {
    currentTheme: ThemeChoice;
    document?: Document;
    nextTheme: ThemeChoice;
    reduceMotion: boolean;
};

export type ThemeTransitionDecisionInput = {
    currentTheme: ThemeChoice;
    nextTheme: ThemeChoice;
    reduceMotion: boolean;
    supportsViewTransition: boolean;
};

export function shouldAnimateThemeTransition(input: ThemeTransitionDecisionInput): boolean {
    if (input.reduceMotion) return false;
    if (!input.supportsViewTransition) return false;
    return input.currentTheme !== input.nextTheme;
}

export async function applyThemeWithTransition(input: ThemeTransitionInput): Promise<void> {
    const documentLike = input.document ?? (typeof document === 'undefined' ? null : document);
    if (!documentLike) return;

    const viewTransitionDocument = documentLike as ViewTransitionDocument;
    const startViewTransition = viewTransitionDocument.startViewTransition;
    const animate = documentLike.documentElement.animate;
    const apply = () => {
        documentLike.documentElement.setAttribute('data-theme', input.nextTheme);
    };

    if (!shouldAnimateThemeTransition({
        currentTheme: input.currentTheme,
        nextTheme: input.nextTheme,
        reduceMotion: input.reduceMotion,
        supportsViewTransition: typeof startViewTransition === 'function' && typeof animate === 'function',
    })) {
        apply();
        return;
    }

    const transition = startViewTransition.call(viewTransitionDocument, apply);
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
}
