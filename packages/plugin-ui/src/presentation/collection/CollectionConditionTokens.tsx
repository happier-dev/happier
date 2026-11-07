import { memo, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';

import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_FILTER_CHIP_METRICS } from './filterChipMetrics.js';

export type CollectionConditionToken = Readonly<{ id: string; label: string; valueLabel: string }>;
export type HappierCollectionConditionTokenChipProps = Readonly<{
  token: CollectionConditionToken;
  testID: string;
  removeAccessibilityLabel: string;
  onRemove: (id: string) => void;
}>;
export type HappierCollectionConditionTokensHost = Readonly<{
  Chip: ComponentType<HappierCollectionConditionTokenChipProps>;
  SaveText: ComponentType<Readonly<{ children: ReactNode }>>;
  SaveIcon: ComponentType;
  useAppearance: () => Readonly<{
    gap: number; paddingTop: number; paddingBottom: number; savePaddingHorizontal: number; saveActive: string;
  }>;
}>;
export type HappierCollectionConditionTokensProps = Readonly<{
  host: HappierCollectionConditionTokensHost;
  testIDPrefix: string;
  tokens: readonly CollectionConditionToken[];
  onRemove: (id: string) => void;
  onSave?: () => void;
  labels: Readonly<{ remove: (field: string) => string; save: string }>;
}>;

/** Every condition stays visible by wrapping; Save yields its words to an icon when they crowd the tokens. */
export const HappierCollectionConditionTokens = memo(function HappierCollectionConditionTokens(props: HappierCollectionConditionTokensProps) {
  const { host, tokens, testIDPrefix, onRemove, labels } = props;
  const appearance = host.useAppearance();
  const tokenCount = tokens.length;
  // Hold the width/count at which words wrapped, so room freed by the icon cannot oscillate the label.
  const [iconWithin, setIconWithin] = useState<Readonly<{ width: number; count: number }> | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [wrapped, setWrapped] = useState(false);
  const iconOnly = iconWithin !== null && width !== null && width <= iconWithin.width && tokenCount >= iconWithin.count;
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => current === next ? current : next);
  }, []);
  const onTokensLayout = useCallback((event: LayoutChangeEvent) => {
    setWrapped(event.nativeEvent.layout.height > HAPPIER_FILTER_CHIP_METRICS.minHeightPx * 1.5);
  }, []);
  const hasSave = props.onSave !== undefined;
  useEffect(() => {
    if (!wrapped || iconOnly || !hasSave || width === null) return;
    setIconWithin((current) => current?.width === width && current.count === tokenCount ? current : { width, count: tokenCount });
  }, [hasSave, iconOnly, tokenCount, width, wrapped]);
  return <View testID={`${testIDPrefix}-chips`} onLayout={onRowLayout} style={{
    flexDirection: 'row', alignItems: 'flex-start', gap: appearance.gap,
    paddingTop: appearance.paddingTop, paddingBottom: appearance.paddingBottom,
  }}>
    <View onLayout={onTokensLayout} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: appearance.gap }}>
      {tokens.map((token) => <host.Chip key={token.id} token={token} testID={`${testIDPrefix}-token:${token.id}`} removeAccessibilityLabel={labels.remove(token.label)} onRemove={onRemove} />)}
    </View>
    {props.onSave ? <View style={{ flexShrink: 0, minHeight: HAPPIER_FILTER_CHIP_METRICS.minHeightPx, justifyContent: 'center' }}>
      <HappierPressable testID={`${testIDPrefix}-tokens-save`} accessibilityRole="button" accessibilityLabel={labels.save} onPress={props.onSave}
        style={(state) => ({
          paddingHorizontal: appearance.savePaddingHorizontal, minHeight: Platform.OS === 'web' ? 24 : 44,
          justifyContent: 'center', borderRadius: 6,
          ...(iconOnly ? { minWidth: Platform.OS === 'web' ? 24 : 44, alignItems: 'center' } : {}),
          ...(state.hovered || state.pressed ? { backgroundColor: appearance.saveActive } : {}),
        })}>
        {iconOnly ? <host.SaveIcon /> : <host.SaveText>{labels.save.replace('…', '')}</host.SaveText>}
      </HappierPressable>
    </View> : null}
  </View>;
});
