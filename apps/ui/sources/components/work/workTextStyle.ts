import type { TextStyle } from 'react-native';
import { resolveHappierWorkTextStep, type HappierWorkTextProps } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';

type WorkTextStyle = Pick<TextStyle, 'fontFamily' | 'fontWeight' | 'fontVariant' | 'fontSize' | 'lineHeight' | 'letterSpacing'>;
const workTextStyles = new Map<string, WorkTextStyle>();

/**
 * A Work text role in core's own family for its weight (and tabular figures where the role asks). A host
 * that must draw a shared slot with its own text (a find-aware transcript card) uses the same step.
 * Kept independent of components so stylesheets can resolve their roles during module initialization.
 */
export function workTextStyle(role: HappierWorkTextProps['role'], strong?: boolean): WorkTextStyle {
    const key = `${role}:${strong === true ? 'strong' : 'plain'}`;
    const existing = workTextStyles.get(key);
    if (existing) return existing;
    const step = resolveHappierWorkTextStep(role, strong);
    const style: WorkTextStyle = {
        ...Typography.default(step.weight),
        ...(step.tabular ? Typography.tabular() : null),
        fontSize: step.fontSize,
        lineHeight: step.lineHeight,
        ...(step.letterSpacing === undefined ? null : { letterSpacing: step.letterSpacing }),
    };
    workTextStyles.set(key, style);
    return style;
}
