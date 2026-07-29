import type { MeterTone } from '@/components/ui/lists/MeterBar';

/**
 * Minimal structural shape of the theme needed to resolve a quota tone color.
 *
 * Kept structural (rather than importing the full `Theme`) so this stays a pure,
 * trivially testable mapping. The app `Theme` satisfies it via width subtyping.
 */
export type QuotaToneColorTheme = Readonly<{
    colors: Readonly<{
        state: Readonly<Record<MeterTone, Readonly<{ foreground: string }>>>;
    }>;
}>;

/**
 * Resolve the themed color for a quota tone.
 *
 * success = green, warning = amber, danger = red, neutral = grey (no data).
 * `TokenUsageRing` keeps its own amber-as-neutral mapping — do NOT fold it here.
 */
export function resolveQuotaToneColor(theme: QuotaToneColorTheme, tone: MeterTone): string {
    return theme.colors.state[tone].foreground;
}
