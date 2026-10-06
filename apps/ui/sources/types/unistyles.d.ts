import 'react-native-unistyles';
import type { Theme as AppTheme } from '@/theme';

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends Readonly<Record<'light' | 'dark', AppTheme>> {}
    export interface UnistylesBreakpoints {
        xs: number;
        sm: number;
        md: number;
        lg: number;
        xl: number;
    }
}
