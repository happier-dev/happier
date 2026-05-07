import Color from 'color';

export function resolveWebBlurTintColor(params: Readonly<{ surfaceColor: string; dark: boolean }>): string {
    try {
        const alpha = params.dark ? 0.20 : 0.25;
        return Color(params.surfaceColor).alpha(alpha).rgb().string();
    } catch {
        return params.dark ? 'rgba(0, 0, 0, 0.20)' : 'rgba(255, 255, 255, 0.25)';
    }
}
