import { Platform } from 'react-native';

import { Typography } from '@/constants/Typography';

const fallbackMonoFontFamily = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export function resolveCodeMonoFontFamily(): string {
    const monoTypography = Typography.mono;

    if (typeof monoTypography === 'function') {
        const monoStyle = monoTypography();
        if (typeof monoStyle.fontFamily === 'string' && monoStyle.fontFamily.trim().length > 0) {
            return monoStyle.fontFamily;
        }
    }

    return fallbackMonoFontFamily;
}
