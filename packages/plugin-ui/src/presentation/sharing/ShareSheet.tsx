import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { resolveHappierButtonChrome, useHappierButtonMaterial } from '../interaction/buttonChrome.js';
import { useOptionalHappierUiTheme } from '../../environment/context.js';
import { HappierText } from '../text/Text.js';
import { useHappierShareHost, type HappierShareAction, type HappierShareHost } from './ShareGrantRow.js';

export type HappierShareSheetButtonProps = HappierShareAction & Readonly<{
  leading?: ReactNode;
  emphasis: 'primary' | 'secondary';
  style?: HappierStyleProp;
}>;

export type HappierShareSheetProps = Readonly<{
  /** The caller's list/rows retain their search, selection, keyboard and focus owner. */
  children: ReactNode;
  presentation: 'full' | 'compact' | 'inline';
  phone?: boolean;
  handoffs?: readonly (HappierShareAction & Readonly<{ leading?: ReactNode }>)[];
  done?: HappierShareAction;
  /** The footer's one consequence line beside Done ("Their agents use it through your machine"). */
  note?: string;
  Button?: ComponentType<HappierShareSheetButtonProps>;
  host?: HappierShareHost;
  testID?: string;
}>;

function DefaultButton(props: HappierShareSheetButtonProps) {
  const theme = useOptionalHappierUiTheme();
  if (!theme) throw new Error('Sharing buttons require a mounted theme or a Button binding.');
  const material = useHappierButtonMaterial(theme);
  const chrome = (focused: boolean, disabled: boolean) => resolveHappierButtonChrome({
    theme, variant: props.emphasis, size: 'small', focused, disabled, ...material,
  });
  return <HappierPressable testID={props.testID} accessibilityLabel={props.accessibilityLabel ?? props.label}
    disabled={props.disabled} onPress={props.onPress} style={state => [chrome(state.focused, state.disabled).style, props.style]}>
    {props.leading}<HappierText variant="label" style={{ color: chrome(false, props.disabled === true).foreground }}>{props.label}</HappierText>
  </HappierPressable>;
}

/** Share-sheet body/footer anatomy. No directory, grant, clipboard, modal or route services. */
export function HappierShareSheet(props: HappierShareSheetProps) {
  const host = useHappierShareHost(props.host);
  const Button = props.Button ?? DefaultButton;
  const { Text } = host;
  return <View testID={props.testID} style={props.presentation === 'full' ? styles.full : styles.compact}>
    {props.children}
    {props.presentation === 'full' && (props.handoffs?.length || props.done || props.note) ? <View style={[
      styles.footer, { borderTopColor: host.borderColor }, props.phone ? styles.phoneFooter : null,
    ]}>
      <View style={[styles.handoffs, props.phone ? styles.phoneHandoffs : null]}>
        {props.note ? <View style={styles.footerNote}><Text tone="secondary">{props.note}</Text></View> : null}
        {props.handoffs?.map((action, index) => <Button key={action.testID ?? index} {...action} emphasis="secondary"
          style={props.phone ? styles.phoneAction : styles.action} />)}
      </View>
      {props.done ? <Button {...props.done} emphasis="primary" style={props.phone ? styles.phoneDone : styles.action} /> : null}
    </View> : null}
  </View>;
}

export type HappierShareHelpProps = Readonly<{
  levels: readonly Readonly<{ label: string; text: string }>[];
  note?: string;
  noteIcon?: ReactNode;
  host?: HappierShareHost;
  testID?: string;
}>;

/** The caller's level legend and sharing rules, outside the selectable roster. */
export function HappierShareHelp(props: HappierShareHelpProps) {
  const host = useHappierShareHost(props.host);
  const { Text } = host;
  // Nothing to explain draws nothing: an empty padded block would leave dead space under the list.
  if (!props.levels.length && !props.note) return null;
  return <View testID={props.testID} style={styles.help}>
    {/* One level per line: a level and what it allows never run into the next one's label. */}
    {props.levels.length ? <View style={styles.levels}>{props.levels.map((line) => <View key={line.label} style={styles.level}>
      {/* The dash keeps the level and what it allows as two readable parts ("Can view — read the session"). */}
      <Text tone="secondary"><Text tone="strong">{line.label}</Text>{` — ${line.text}`}</Text>
    </View>)}</View> : null}
    {props.note ? <View testID={props.testID ? `${props.testID}:note:0` : undefined} style={[styles.note, { backgroundColor: host.noteColor }]}>
      {props.noteIcon}<View style={{ flex: 1, minWidth: 0 }}><Text tone="secondary">{props.note}</Text></View>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  full: { flex: 1, minHeight: 0 }, compact: { minHeight: 0 },
  footer: { paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx, paddingVertical: HAPPIER_PAGE_METRICS.groupHeadingGapPx,
    borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx },
  handoffs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', flexShrink: 1, gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx },
  // A wrapping column sizes its line to the widest child, which would stop Done short of the edge.
  footerNote: { flexShrink: 1, minWidth: 0 },
  action: { flexGrow: 0 }, phoneFooter: { flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' },
  phoneHandoffs: { alignSelf: 'stretch', justifyContent: 'space-between', flexWrap: 'nowrap' },
  // Hand-offs keep their own width on a phone, so a longer label stays on one line beside a short one.
  phoneAction: { flexShrink: 1, minWidth: 0 }, phoneDone: { alignSelf: 'stretch' },
  help: { paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx, paddingVertical: HAPPIER_PAGE_METRICS.groupSeparatorGapPx,
    gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx },
  levels: { flexDirection: 'column' },
  level: { maxWidth: '100%', flexShrink: 1 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx,
    padding: HAPPIER_PAGE_METRICS.groupSeparatorGapPx, borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx },
});
