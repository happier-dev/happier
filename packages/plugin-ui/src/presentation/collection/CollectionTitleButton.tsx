import * as React from 'react';
import { Pressable, View } from 'react-native';

import { HAPPIER_COLLECTION_LIST_METRICS } from './CollectionList.js';
import { useHappierHitArea } from '../interaction/hitArea.js';
import type { HappierLayoutChangeEvent, HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';

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
    // The label, its chevron and a trailing state share the title's baseline: the chevron's foot and the quiet
    // state's text stand on the line the title stands on, whatever the title's size (a column heading or a phone's
    // large title), while the trigger centres the whole line in its row.
    labelRow: { flexDirection: 'row' as const, alignItems: 'baseline' as const, gap: 6, minWidth: 0, flexShrink: 1 },
    triggerPressed: { backgroundColor: ink.pressed },
    triggerLabel: { ...ink.label, minWidth: 0, flexShrink: 1, color: ink.text },
    labelBox: { minWidth: 0, flexShrink: 1 },
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
  Text: React.ComponentType<Readonly<{ children: React.ReactNode; numberOfLines?: number; style: HappierStyleProp }>>;
  chevron: React.ReactNode;
  /** A quiet state after the chevron (a saved view that now differs: "Filtered"); the caller names it in the label. */
  trailing?: React.ReactNode;
}>;

/** One title control and one inaccessible measuring copy, for core and plugin collections. */
export const HappierCollectionTitleButton = React.memo(function HappierCollectionTitleButton(props: HappierCollectionTitleButtonProps) {
  const { styles, Text } = props;
  const hitArea = useHappierCollectionTitleTriggerHitArea(styles);
  const reportNaturalWidth = React.useContext(CollectionTitleNaturalWidthContext);
  // A phone's hero title stands on one line. A name too long for that at this width (a long Space, a phone at
  // large text) takes the heading step and wraps there by words, until the title has more room again.
  const [heroWrappedAtWidth, setHeroWrappedAtWidth] = React.useState<number | null>(null);
  const triggerWidthRef = React.useRef(0);
  const heroStep = props.phone && props.scale !== 'section';
  const hero = heroStep && heroWrappedAtWidth === null;
  const labelWidths = React.useRef({ box: 0, natural: 0 });
  const labelStyle = [styles.triggerLabel, hero ? styles.phoneTriggerLabel : null];
  const handleTriggerLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
    hitArea.onLayout?.(event);
    const width = event.nativeEvent.layout.width;
    triggerWidthRef.current = width;
    setHeroWrappedAtWidth((wrappedAt) => (wrappedAt !== null && width > wrappedAt + 1 ? null : wrappedAt));
  }, [hitArea]);
  // The hero label's one-line width against the width its box gets: wider means it would wrap.
  const checkHeroFits = React.useCallback(() => {
    const { box, natural } = labelWidths.current;
    if (hero && box > 0 && natural > box + 1) setHeroWrappedAtWidth(triggerWidthRef.current);
  }, [hero]);
  const handleLabelLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
    labelWidths.current.box = event.nativeEvent.layout.width;
    checkHeroFits();
  }, [checkHeroFits]);
  const handleNaturalLabelLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
    labelWidths.current.natural = event.nativeEvent.layout.width;
    checkHeroFits();
  }, [checkHeroFits]);
  const handleNaturalLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    reportNaturalWidth?.(event.nativeEvent.layout.width - OPTICAL_INSET_PX);
  }, [reportNaturalWidth]);
  return <Pressable testID={props.testID} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel}
    accessibilityState={{ expanded: props.expanded }} aria-expanded={props.expanded} aria-haspopup={props.hasPopup}
    onPress={props.onPress} hitSlop={hitArea.hitSlop} onLayout={handleTriggerLayout}
    style={({ pressed }) => [styles.trigger, pressed ? styles.triggerPressed : null]}>
    {hitArea.frame}
    <View style={styles.labelRow}>
      {/* A Space's name is authored: it wraps under a large title rather than being cut (FIN-QA-LARGETEXT T1).
          The measuring copy below keeps one line, so the row still yields its controls first. */}
      <View style={styles.labelBox} onLayout={heroStep ? handleLabelLayout : undefined}>
        <Text style={labelStyle}>{props.label}</Text>
      </View>
      {props.chevron}
      {props.trailing ?? null}
    </View>
    {hero ? <View style={styles.naturalClip} pointerEvents="none" aria-hidden
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.naturalRow}>
        <View onLayout={handleNaturalLabelLayout}><Text numberOfLines={1} style={labelStyle}>{props.label}</Text></View>
      </View>
    </View> : null}
    {reportNaturalWidth ? <View style={styles.naturalClip} pointerEvents="none" aria-hidden
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.naturalRow}>
        <View testID={`${props.testID}-natural`} onLayout={handleNaturalLayout} style={[styles.trigger, styles.naturalTrigger]}>
          <View style={styles.labelRow}>
            <Text numberOfLines={1} style={labelStyle}>{props.label}</Text>
            {props.chevron}
            {props.trailing ?? null}
          </View>
        </View>
      </View>
    </View> : null}
  </Pressable>;
});
