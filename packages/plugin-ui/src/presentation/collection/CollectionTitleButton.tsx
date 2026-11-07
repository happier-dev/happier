import * as React from 'react';
import { Pressable, View } from 'react-native';

import { HAPPIER_COLLECTION_LIST_METRICS } from './CollectionList.js';
import { useHappierHitArea } from '../interaction/hitArea.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';

/** Optical inset of the press fill; the title itself stays on the collection's text edge. */
const OPTICAL_INSET_PX = 6;

/** A title row uses the whole title's natural width to yield adjacent controls before truncating it. */
export const CollectionTitleNaturalWidthContext = React.createContext<((widthPx: number) => void) | null>(null);

/** Geometry shared by title buttons, titled filters and the decorative neighbouring Space title. */
export function resolveHappierCollectionTitleStyles<Label extends HappierPortableStyle, PhoneLabel extends HappierPortableStyle>(ink: Readonly<{
  text: string;
  pressed: string;
  label: Label;
  phoneLabel: PhoneLabel;
}>) {
  return {
    trigger: {
      minHeight: HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight,
      minWidth: HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight,
      flexShrink: 1,
      paddingHorizontal: OPTICAL_INSET_PX,
      marginLeft: -OPTICAL_INSET_PX,
      borderRadius: 8,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'flex-start' as const,
      gap: 6,
    },
    triggerPressed: { backgroundColor: ink.pressed },
    triggerLabel: { ...ink.label, minWidth: 0, flexShrink: 1, color: ink.text },
    phoneTriggerLabel: ink.phoneLabel,
    naturalClip: { position: 'absolute' as const, left: 0, top: 0, width: 0, height: 0, overflow: 'hidden' as const },
    naturalRow: { position: 'absolute' as const, left: 0, top: 0, width: 4096, flexDirection: 'row' as const, alignItems: 'flex-start' as const },
    naturalTrigger: { flexShrink: 0, marginLeft: 0 },
  };
}

export type HappierCollectionTitleStyles = ReturnType<typeof resolveHappierCollectionTitleStyles>;

/** Hit reach for a raw native pressable using the shared title anatomy. */
export function useHappierCollectionTitleTriggerHitArea(styles: Pick<HappierCollectionTitleStyles, 'trigger'>) {
  return useHappierHitArea({ restingStyle: () => styles.trigger });
}

export type HappierCollectionTitleButtonProps = Readonly<{
  testID: string;
  label: string;
  accessibilityLabel: string;
  expanded: boolean;
  hasPopup: 'menu' | 'dialog';
  onPress: () => void;
  /** A column-as-page takes its hero title on phones; a section stays a heading. */
  scale?: 'page' | 'section';
  phone: boolean;
  styles: HappierCollectionTitleStyles;
  Text: React.ComponentType<Readonly<{ children: React.ReactNode; numberOfLines: number; style: HappierStyleProp }>>;
  chevron: React.ReactNode;
  /** A quiet state after the chevron (a saved view that now differs: "Filtered"); the caller names it in the label. */
  trailing?: React.ReactNode;
}>;

/** One title control and one inaccessible measuring copy, for core and plugin collections. */
export const HappierCollectionTitleButton = React.memo(function HappierCollectionTitleButton(props: HappierCollectionTitleButtonProps) {
  const { styles, Text } = props;
  const hitArea = useHappierCollectionTitleTriggerHitArea(styles);
  const reportNaturalWidth = React.useContext(CollectionTitleNaturalWidthContext);
  const labelStyle = [styles.triggerLabel, props.phone && props.scale !== 'section' ? styles.phoneTriggerLabel : null];
  const handleNaturalLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    reportNaturalWidth?.(event.nativeEvent.layout.width - OPTICAL_INSET_PX);
  }, [reportNaturalWidth]);
  return <Pressable testID={props.testID} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel}
    accessibilityState={{ expanded: props.expanded }} aria-expanded={props.expanded} aria-haspopup={props.hasPopup}
    onPress={props.onPress} hitSlop={hitArea.hitSlop} onLayout={hitArea.onLayout}
    style={({ pressed }) => [styles.trigger, pressed ? styles.triggerPressed : null]}>
    {hitArea.frame}
    <Text numberOfLines={1} style={labelStyle}>{props.label}</Text>
    {props.chevron}
    {props.trailing ?? null}
    {reportNaturalWidth ? <View style={styles.naturalClip} pointerEvents="none" aria-hidden
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.naturalRow}>
        <View testID={`${props.testID}-natural`} onLayout={handleNaturalLayout} style={[styles.trigger, styles.naturalTrigger]}>
          <Text numberOfLines={1} style={labelStyle}>{props.label}</Text>
          {props.chevron}
          {props.trailing ?? null}
        </View>
      </View>
    </View> : null}
  </Pressable>;
});
