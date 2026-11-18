import type * as React from 'react';
import { Text as RNText, type StyleProp, type TextStyle } from 'react-native';

export type TextSpanProps = Readonly<{
    /**
     * Paint only (ink, weight, a run's wash, an underline): metrics would need the UI font scale, which the
     * enclosing app `Text` applies. Web inline wrapping hints (`display`, `overflowWrap`) ride along as web-only
     * style values.
     */
    style?: StyleProp<Pick<TextStyle, 'color' | 'fontWeight' | 'backgroundColor' | 'borderRadius'
        | 'textDecorationLine' | 'textDecorationStyle' | 'textDecorationColor'>>;
    children?: React.ReactNode;
}>;

/**
 * A run nested inside an app `Text` that only paints (a syntax token's color and weight, a diff segment's wash, a
 * problem underline, a wrapped word). Nested text inherits
 * typography, the UI font scale, host font scaling and selectability from its enclosing app `Text` on every
 * platform, so a span skips the adapter's layers and per-instance subscriptions; code views mount one per token.
 * Resolve a theme ink through the enclosing component's `useGlassBackedInk` before passing it.
 */
export const TextSpan: React.ComponentType<TextSpanProps> = RNText;
