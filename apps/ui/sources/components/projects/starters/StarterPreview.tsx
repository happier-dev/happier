import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The New app gallery's starter preview (lab servers-deploy s1 "gallery"): a quiet sketch of the kind of
 * app the starter makes, drawn in the theme's own inks. The app does not exist yet, so the honest
 * preview is its shape (a page, a dashboard, a phone, an article), never a screenshot.
 */
export type StarterPreviewShape =
  | 'site'
  | 'dashboard'
  | 'mobile'
  | 'article'
  | 'describe';

/** Reads the shape from the starter's own tags; an unknown starter is drawn as a site. */
export function resolveStarterPreviewShape(
  tags: readonly string[] | null | undefined,
): StarterPreviewShape {
  const set = new Set((tags ?? []).map((tag) => tag.toLowerCase()));
  if (set.has('mobile') || set.has('expo') || set.has('react-native'))
    return 'mobile';
  if (set.has('content') || set.has('blog') || set.has('markdown'))
    return 'article';
  if (set.has('fullstack') || set.has('dashboard') || set.has('react'))
    return 'dashboard';
  return 'site';
}

export const StarterPreview = React.memo(function StarterPreview(
  props: Readonly<{ shape: StarterPreviewShape }>,
) {
  switch (props.shape) {
    case 'describe':
      return (
        <View style={styles.center}>
          <View style={styles.spark} />
        </View>
      );
    case 'mobile':
      return (
        <View style={styles.center}>
          <View style={styles.phone}>
            <View style={[styles.line, styles.w60]} />
            <View style={[styles.line, styles.w80, styles.faint]} />
            <View style={styles.phoneBlock} />
            <View style={[styles.pill, styles.selfCenter]} />
          </View>
        </View>
      );
    case 'article':
      return (
        <View style={styles.article}>
          <View style={[styles.line, styles.w20]} />
          <View style={[styles.bar, styles.w60]} />
          <View style={[styles.line, styles.w100, styles.faint]} />
          <View style={[styles.line, styles.w100, styles.faint]} />
          <View style={[styles.line, styles.w80, styles.faint]} />
        </View>
      );
    case 'dashboard':
      return (
        <View style={styles.dashboard}>
          <View style={styles.sidebar}>
            <View style={[styles.line, styles.w100]} />
            <View style={[styles.line, styles.w80, styles.faint]} />
            <View style={[styles.line, styles.w80, styles.faint]} />
            <View style={[styles.line, styles.w60, styles.faint]} />
          </View>
          <View style={styles.table}>
            {[0, 1, 2, 3].map((row) => (
              <View key={row} style={styles.tableRow}>
                <View style={[styles.cell, styles.faint]} />
                <View style={[styles.cell, styles.faint]} />
                <View
                  style={[
                    styles.cell,
                    row === 1 ? styles.emphasis : styles.faint,
                  ]}
                />
              </View>
            ))}
          </View>
        </View>
      );
    case 'site':
    default:
      return (
        <View style={styles.site}>
          <View style={styles.siteHeader}>
            <View style={[styles.line, styles.w30]} />
            <View style={styles.pillSmall} />
          </View>
          <View style={[styles.line, styles.w60, styles.faint]} />
          <View style={styles.cards}>
            {[0, 1, 2, 3].map((card) => (
              <View key={card} style={styles.card} />
            ))}
          </View>
        </View>
      );
  }
});

const styles = StyleSheet.create((theme) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  site: { flex: 1, padding: theme.space.s12, gap: theme.space.s8 },
  siteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cards: {
    flex: 1,
    flexDirection: 'row',
    gap: theme.space.s6,
    marginTop: theme.space.s4,
  },
  card: {
    flex: 1,
    borderRadius: theme.space.s4,
    backgroundColor: theme.colors.border.default,
  },
  article: {
    flex: 1,
    paddingHorizontal: '18%',
    paddingVertical: theme.space.s12,
    gap: theme.space.s6,
    justifyContent: 'center',
  },
  dashboard: {
    flex: 1,
    flexDirection: 'row',
    padding: theme.space.s12,
    gap: theme.space.s12,
  },
  sidebar: { width: '22%', gap: theme.space.s6 },
  table: { flex: 1, gap: theme.space.s6, justifyContent: 'center' },
  tableRow: { flexDirection: 'row', gap: theme.space.s6 },
  cell: { flex: 1, height: theme.space.s4, borderRadius: theme.space.s2 },
  phone: {
    width: '22%',
    height: '84%',
    borderRadius: theme.space.s8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.strong,
    padding: theme.space.s6,
    gap: theme.space.s4,
  },
  phoneBlock: {
    flex: 1,
    borderRadius: theme.space.s4,
    backgroundColor: theme.colors.border.default,
  },
  line: {
    height: theme.space.s4,
    borderRadius: theme.space.s2,
    backgroundColor: theme.colors.surface.skeleton,
  },
  bar: {
    height: theme.space.s6,
    borderRadius: theme.space.s2,
    backgroundColor: theme.colors.surface.skeleton,
  },
  faint: { backgroundColor: theme.colors.border.default },
  emphasis: { backgroundColor: theme.colors.text.secondary },
  pill: {
    width: '50%',
    height: theme.space.s6,
    borderRadius: theme.space.s4,
    backgroundColor: theme.colors.text.secondary,
  },
  pillSmall: {
    width: '14%',
    height: theme.space.s6,
    borderRadius: theme.space.s4,
    backgroundColor: theme.colors.text.secondary,
  },
  selfCenter: { alignSelf: 'center' },
  spark: {
    width: theme.space.s16,
    height: theme.space.s16,
    borderRadius: theme.space.s8,
    borderWidth: 1.5,
    borderColor: theme.colors.text.secondary,
  },
  w20: { width: '20%' },
  w30: { width: '30%' },
  w60: { width: '60%' },
  w80: { width: '80%' },
  w100: { width: '100%' },
}));
