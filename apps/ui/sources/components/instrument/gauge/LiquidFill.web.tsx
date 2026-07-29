import type { SharedValue } from 'react-native-reanimated';

/**
 * Web build of the tier-1 liquid fill. The web tier policy (L4 T1.3) is
 * tier-2-only, so this stub keeps `@shopify/react-native-skia` out of the web
 * bundle entirely; `ContextGauge` never selects tier 1 when unsupported.
 */

export function isLiquidFillSupported(): boolean {
    return false;
}

export type LiquidFillProps = Readonly<{
    fillPct: SharedValue<number>;
    size: number;
    isStreaming: boolean;
    okColor: string;
    warnColor: string;
    dangerColor: string;
    trackColor: string;
    testID?: string;
}>;

export function LiquidFill(_props: LiquidFillProps): null {
    return null;
}
