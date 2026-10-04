import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ReviewFinding } from '@happier-dev/protocol';

import { reviewSeverityTone, type ReviewSeverityTone } from './reviewFindingPresentation';

type Theme = ReturnType<typeof useUnistyles>['theme'];

/** The theme colours of a severity tone: its foreground and the quiet tint a chip sits on. */
export function resolveReviewSeverityColors(theme: Theme, tone: ReviewSeverityTone): Readonly<{ foreground: string; tint: string }> {
    switch (tone) {
        case 'danger': return { foreground: theme.colors.state.danger.foreground, tint: theme.colors.state.danger.background };
        case 'warning': return { foreground: theme.colors.state.warning.foreground, tint: theme.colors.state.warning.background };
        case 'accent': return { foreground: theme.colors.accent.blue, tint: theme.colors.state.active.background };
        case 'quiet': return { foreground: theme.colors.text.tertiary, tint: theme.colors.surface.inset };
    }
}

/** One severity colour wherever a finding is drawn: transcript card, Run page and walkthrough. */
export function useReviewSeverityColors(severity: ReviewFinding['severity']): Readonly<{ foreground: string; tint: string }> {
    const { theme } = useUnistyles();
    return resolveReviewSeverityColors(theme, reviewSeverityTone(severity));
}

/** The same colours as a function, for a renderer that resolves many findings at once (inline citations). */
export function useReviewSeverityColorResolver(): (severity: ReviewFinding['severity']) => Readonly<{ foreground: string; tint: string }> {
    const { theme } = useUnistyles();
    return React.useCallback((severity) => resolveReviewSeverityColors(theme, reviewSeverityTone(severity)), [theme]);
}
