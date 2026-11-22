import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';

export type HappierPublicLinkCardProps = Readonly<{
  testID: string;
  /** The enclosing Share sheet row already presents the link's title and state. */
  presentation?: 'card' | 'inline';
  published: boolean;
  loaded: boolean;
  configuring: boolean;
  shareUrl: string | null;
  /**
   * What the issued link reads as in its field ("Link to this document"). With it, the raw address is never drawn:
   * Copy, Open and the QR code carry it. Without it, the field shows the address itself.
   */
  urlLabel?: string;
  title: string;
  status: string;
  hiddenLabel: string;
  detail: string;
  description: string;
  expiresLabel: string;
  usesLabel: string;
  consentTitle: string;
  consentDescription: string;
  replacementNote: string;
  colors: Readonly<{ border: string; inset: string; surface: string; text: string; secondary: string; success: string }>;
  typography: Readonly<{ title: HappierPortableStyle; subtitle: HappierPortableStyle; emphasizedSubtitle: HappierPortableStyle; mono: HappierPortableStyle; consentTitle: HappierPortableStyle }>;
  Text: ComponentType<Readonly<{ children?: ReactNode; style?: HappierStyleProp; testID?: string; numberOfLines?: number; selectable?: boolean }>>;
  linkMark: ReactNode;
  statusMark: ReactNode;
  notices?: ReactNode;
  copyFeedback?: ReactNode;
  copyControl?: ReactNode;
  qr?: ReactNode;
  qrControl?: ReactNode;
  /** Null withdraws "new link" for the same reason. */
  newControl: ReactNode;
  /** Another operation on the issued link (a document's Access log), in the same row after New link. */
  linkControl?: ReactNode;
  turnOffControl: ReactNode;
  /** Null withdraws the whole offer to make a link: the Home cannot publish until it is set up. */
  createControl: ReactNode;
  expiryControl: ReactNode;
  usesControl: ReactNode;
  consentControl: ReactNode;
  /** A second switch in the options, drawn like consent (a visual's network access, when the link carries one). */
  networkTitle?: string;
  networkDescription?: string;
  networkControl?: ReactNode;
  cancelControl: ReactNode;
  submitControl: ReactNode;
}>;

/** Shared public-link anatomy. The host owns publication, bearer custody and every effect. */
export function HappierPublicLinkCard(props: HappierPublicLinkCardProps) {
  const { Text, colors, typography } = props;
  const meta = [typography.subtitle, { color: colors.secondary }];
  const label = [typography.emphasizedSubtitle, { color: colors.secondary }];
  return (
    <View testID={props.testID} style={props.presentation === 'inline' ? styles.inline : [styles.card, { borderColor: colors.border, backgroundColor: colors.inset }]}>
      {props.presentation !== 'inline' ? <View style={styles.top}>
        {props.linkMark}
        <Text style={[typography.title, { color: colors.text, flex: 1 }]}>{props.title}</Text>
        {props.published || props.loaded ? <View style={styles.status}>
          {props.published ? props.statusMark : null}
          <Text testID="session-public-link-status" style={[typography.emphasizedSubtitle, { color: props.published ? colors.success : colors.secondary }]}>{props.status}</Text>
        </View> : null}
      </View> : null}
      {props.notices}
      {props.published && !props.configuring ? <>
        {props.shareUrl ? <View style={[styles.url, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          {props.urlLabel
            ? <Text testID="session-public-link-url" style={[typography.subtitle, { color: colors.text, flex: 1, minWidth: 0 }]} numberOfLines={1}>{props.urlLabel}</Text>
            : <Text testID="session-public-link-url" style={[typography.mono, { color: colors.text, flex: 1, minWidth: 0 }]} numberOfLines={1} selectable>{props.shareUrl}</Text>}
          {props.copyFeedback}{props.copyControl}
        </View> : <Text testID="session-public-link-hidden" style={meta}>{props.hiddenLabel}</Text>}
        <Text testID="session-public-link-detail" style={meta}>{props.detail}</Text>
        {props.qr ? <View style={styles.qr} testID="session-public-link-qr-code">{props.qr}</View> : null}
        <View style={styles.actions}>{props.qrControl}{props.newControl}{props.linkControl}<View style={styles.grow} />{props.turnOffControl}</View>
      </> : null}
      {!props.published && !props.configuring && props.loaded && props.createControl ? <>
        <Text style={meta}>{props.description}</Text>
        <View style={styles.actions}>{props.createControl}</View>
      </> : null}
      {props.configuring ? <View style={styles.options} testID="session-public-link-options">
        <View style={styles.optionGroup}><Text style={label}>{props.expiresLabel}</Text>{props.expiryControl}</View>
        <View style={styles.optionGroup}><Text style={label}>{props.usesLabel}</Text>{props.usesControl}</View>
        <View style={styles.consent}>
          <View style={styles.consentText}>
            <Text style={[typography.consentTitle, { color: colors.text }]}>{props.consentTitle}</Text>
            <Text style={meta}>{props.consentDescription}</Text>
          </View>
          {props.consentControl}
        </View>
        {props.networkControl ? <View style={styles.consent}>
          <View style={styles.consentText}>
            <Text style={[typography.consentTitle, { color: colors.text }]}>{props.networkTitle}</Text>
            {props.networkDescription ? <Text style={meta}>{props.networkDescription}</Text> : null}
          </View>
          {props.networkControl}
        </View> : null}
        {props.published ? <Text style={meta}>{props.replacementNote}</Text> : null}
        <View style={styles.actions}><View style={styles.grow} />{props.cancelControl}{props.submitControl}</View>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inline: { gap: HAPPIER_PAGE_METRICS.cardSectionGapPx },
  card: { marginHorizontal: 12, marginBottom: 12, padding: HAPPIER_PAGE_METRICS.cardPaddingPx, gap: HAPPIER_PAGE_METRICS.cardContentGapPx, borderRadius: HAPPIER_PAGE_METRICS.cardRadiusPx, borderWidth: StyleSheet.hairlineWidth },
  top: { flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.headerGapPx },
  status: { flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.rowCompactGapPx },
  url: { minHeight: 34, paddingLeft: HAPPIER_PAGE_METRICS.rowInsetPx, paddingRight: 4, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.rowCompactGapPx },
  actions: { flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.actionCompactGapPx, flexWrap: 'wrap' },
  grow: { flex: 1 },
  qr: { alignItems: 'center', paddingVertical: 4 },
  options: { gap: HAPPIER_PAGE_METRICS.cardSectionGapPx },
  optionGroup: { gap: HAPPIER_PAGE_METRICS.rowCompactGapPx },
  consent: { flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.rowContentGapPx },
  consentText: { flex: 1, minWidth: 0, gap: 2 },
});
