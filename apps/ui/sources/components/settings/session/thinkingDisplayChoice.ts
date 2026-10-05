import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';

/**
 * How a session shows the agent's thinking: one person-facing choice stored across two Account
 * fields (`sessionThinkingDisplayMode` and, for inline, `sessionThinkingInlinePresentation`).
 * Settings → Transcript, Personalize and the `transcript.displayMode` Action all read and write it
 * here, so the four options can never be interpreted two ways.
 */
export const THINKING_DISPLAY_CHOICES = ['inline_summary', 'inline_full', 'tool', 'hidden'] as const;
export type ThinkingDisplayChoice = typeof THINKING_DISPLAY_CHOICES[number];

export type ThinkingDisplaySettings = Readonly<{
    sessionThinkingDisplayMode?: unknown;
    sessionThinkingInlinePresentation?: unknown;
}>;

export function isThinkingDisplayChoice(value: unknown): value is ThinkingDisplayChoice {
    return typeof value === 'string' && (THINKING_DISPLAY_CHOICES as readonly string[]).includes(value);
}

export function resolveThinkingDisplayChoice(settings: ThinkingDisplaySettings): ThinkingDisplayChoice {
    if (settings.sessionThinkingDisplayMode === 'tool') return 'tool';
    if (settings.sessionThinkingDisplayMode === 'hidden') return 'hidden';
    return settings.sessionThinkingInlinePresentation === 'full' ? 'inline_full' : 'inline_summary';
}

export type ThinkingDisplayChoiceDelta = Readonly<{
    sessionThinkingDisplayMode: 'inline' | 'tool' | 'hidden';
    sessionThinkingInlinePresentation?: 'summary' | 'full';
}>;

/** One write for the whole choice. Tool and Hidden keep the inline presentation for a later return to inline. */
export function resolveThinkingDisplayChoiceDelta(choice: ThinkingDisplayChoice): ThinkingDisplayChoiceDelta {
    switch (choice) {
        case 'inline_summary':
            return { sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'summary' };
        case 'inline_full':
            return { sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full' };
        case 'tool':
            return { sessionThinkingDisplayMode: 'tool' };
        case 'hidden':
            return { sessionThinkingDisplayMode: 'hidden' };
    }
}

/** The declared `transcript.displayMode` row: one owner mutation inside the Account CAS writer. */
export const thinkingDisplayStorageBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    allowedValues: THINKING_DISPLAY_CHOICES,
    read: resolveThinkingDisplayChoice,
    parse: value => isThinkingDisplayChoice(value) ? { success: true, value } : { success: false },
    mutate: (_settings, value) => isThinkingDisplayChoice(value) ? resolveThinkingDisplayChoiceDelta(value) : null,
};
