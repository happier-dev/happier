import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_REVIEW_SEVERITY_TONE, resolveHappierReviewSeverityColor } from '@happier-dev/plugin-ui/presentation';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

type Theme = ReturnType<typeof useUnistyles>['theme'];
type SeverityColors = Readonly<{ foreground: string; textForeground: string; tint: string }>;

/**
 * A severity's colours where a finding sits beside code: its foreground from the shared severity owner
 * (`HAPPIER_REVIEW_SEVERITY_TONE`, the same one plugins draw with) and the quiet tint a chip sits on.
 */
function resolveReviewSeverityColors(theme: Theme, presentationTheme: PluginUiThemeV1, severity: ReviewFinding['severity']): SeverityColors {
    const foreground = resolveHappierReviewSeverityColor(presentationTheme, severity);
    switch (HAPPIER_REVIEW_SEVERITY_TONE[severity]) {
        case 'danger': return { foreground, textForeground: theme.colors.state.danger.textForeground, tint: theme.colors.state.danger.background };
        case 'warning': return { foreground, textForeground: theme.colors.state.warning.textForeground, tint: theme.colors.state.warning.background };
        default: return { foreground, textForeground: foreground, tint: theme.colors.surface.inset };
    }
}

/** One severity colour wherever a finding is drawn: transcript card, Run page and walkthrough. */
export function useReviewSeverityColors(severity: ReviewFinding['severity']): SeverityColors {
    const resolve = useReviewSeverityColorResolver();
    return resolve(severity);
}

/** The same colours as a function, for a renderer that resolves many findings at once (inline citations). */
export function useReviewSeverityColorResolver(): (severity: ReviewFinding['severity']) => SeverityColors {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    return React.useCallback((severity) => resolveReviewSeverityColors(theme, presentationTheme, severity), [theme, presentationTheme]);
}
