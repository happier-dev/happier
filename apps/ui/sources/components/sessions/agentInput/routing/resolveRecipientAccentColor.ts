import type { UnistylesThemes } from 'react-native-unistyles';
import { parseAccentColorKey, type AccentColorKey } from '@/theme/accentColors';

type Theme = UnistylesThemes[keyof UnistylesThemes];

export type RecipientAccentKey = AccentColorKey;

export function resolveRecipientAccentKey(value: string): RecipientAccentKey | null {
    return parseAccentColorKey(value);
}

export function resolveRecipientAccentColor(params: Readonly<{ theme: Theme; accentName: string }>): string | undefined {
    const key = resolveRecipientAccentKey(params.accentName);
    if (!key) return undefined;
    return params.theme.colors.accent[key];
}
