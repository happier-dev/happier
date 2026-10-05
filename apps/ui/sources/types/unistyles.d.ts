import type { Theme } from '../theme';

declare module 'react-native-unistyles' {
    export interface UnistylesThemes {
        readonly light: Theme;
        readonly dark: Theme;
    }

    export interface UnistylesBreakpoints {
        xs: number;
        sm: number;
        md: number;
        lg: number;
        xl: number;
    }
}
