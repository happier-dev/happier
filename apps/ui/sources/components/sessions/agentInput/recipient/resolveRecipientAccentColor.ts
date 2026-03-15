import type { UnistylesThemes } from 'react-native-unistyles';

type Theme = UnistylesThemes[keyof UnistylesThemes];

function toAccentKey(value: string): keyof Theme['colors']['accent'] | null {
    const key = value.trim().toLowerCase();
    if (!key) return null;
    const allowed = new Set(['blue', 'green', 'orange', 'yellow', 'red', 'indigo', 'purple']);
    if (!allowed.has(key)) return null;
    return key as keyof Theme['colors']['accent'];
}

export function resolveRecipientAccentColor(params: Readonly<{ theme: Theme; accentName: string }>): string | undefined {
    const key = toAccentKey(params.accentName);
    if (!key) return undefined;
    return params.theme.colors.accent[key];
}
