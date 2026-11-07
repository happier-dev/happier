import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { usePdfPageCount } from '@/components/ui/media/pdf/usePdfPageCount';
import { previewUnavailableCard } from '@/components/ui/media/previewUnavailable';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

import { formatBytesDelta, type ImageCompareSide } from './imageCompare/imageCompareModel';
import { useImageCompare, type ImageCompareSource } from './imageCompare/useImageCompare';

type Side = 'before' | 'after';

export type PdfChangeRowProps = Readonly<{
  filePath: string;
  before: ImageCompareSide;
  after: ImageCompareSide;
  /** Pages of each side when the host could count them (web); absent leaves the page count out. */
  beforePages: number | null;
  afterPages: number | null;
  /** Opens that revision in the Media stage. */
  onOpen: (side: Side) => void;
  testID?: string;
}>;

function sizeOf(side: ImageCompareSide): number | null {
  return side.kind === 'present' ? side.sizeBytes : null;
}

/**
 * A changed PDF in Review (files lab RV1a): no visual diff, one line of identity — "PDF · 12 → 14 pages ·
 * +210 KB" — with Open before / Open after, which show either revision in the Media stage. Added and
 * deleted PDFs carry the same pill as a picture and offer the one side that exists.
 */
export function PdfChangeRow(props: PdfChangeRowProps) {
  const { theme } = useUnistyles();
  const single = props.before.kind === 'added' ? 'after' as const : props.after.kind === 'deleted' ? 'before' as const : null;
  const pages = (count: number) => t('files.viewer.pdfPageCount', { count });
  const pagesFact = single
    ? (single === 'after' ? props.afterPages : props.beforePages)
    : null;
  const pageText = single
    ? pagesFact === null ? null : pages(pagesFact)
    : props.beforePages !== null && props.afterPages !== null ? `${props.beforePages} → ${pages(props.afterPages)}`
      : props.afterPages !== null ? pages(props.afterPages) : null;
  const sizeText = single
    ? sizeOf(single === 'after' ? props.after : props.before) !== null
      ? formatHappierDataBytes(sizeOf(single === 'after' ? props.after : props.before)!, { kind: 'storage' }) : null
    : formatBytesDelta(sizeOf(props.before), sizeOf(props.after));
  const facts = ['PDF', pageText, sizeText].filter(Boolean).join(' · ');
  const fileName = props.filePath.split('/').pop() || props.filePath;
  const sides: readonly Side[] = single ? [single] : ['before', 'after'];
  const notes = sides.flatMap(side => {
    const state = side === 'before' ? props.before : props.after;
    if (state.kind !== 'unavailable') return [];
    const label = side === 'before' ? t('hunkReview.imageBefore') : t('hunkReview.imageAfter');
    return [`${label}: ${previewUnavailableCard(state.reason, fileName).title}`];
  });

  return (
    <View testID={props.testID} style={styles.root}>
      <View style={styles.row}>
        {single ? (
          <StatusPill variant="neutral" label={single === 'after' ? t('hunkReview.imageAdded') : t('hunkReview.imageDeleted')} />
        ) : null}
        <Text variant="meta" style={[styles.facts, { color: theme.colors.text.secondary }]}>{facts}</Text>
        <View style={styles.actions}>
          {sides.map(side => (
            <RoundButton
              key={side}
              testID={`pdf-change-open-${side}`}
              size="mini"
              display="secondary"
              title={side === 'before' ? t('hunkReview.pdfOpenBefore') : t('hunkReview.pdfOpenAfter')}
              disabled={(side === 'before' ? props.before : props.after).kind !== 'present'}
              onPress={() => props.onOpen(side)}
            />
          ))}
        </View>
      </View>
      {notes.map(note => (
        <Text key={note} variant="meta" style={{ color: theme.colors.text.tertiary }}>{note}</Text>
      ))}
    </View>
  );
}

/** Review's changed PDF through the revision read and Media stage the picture compare already uses. */
export function ReviewPdfChange(props: Readonly<{
  scope: WorkspaceScopeBase;
  filePath: string;
  source: ImageCompareSource;
  testID?: string;
}>) {
  const compare = useImageCompare({ enabled: true, scope: props.scope, filePath: props.filePath, source: props.source });
  const stage = useMediaStage();
  const beforePages = usePdfPageCount(compare.before.kind === 'present' ? compare.before.uri : null);
  const afterPages = usePdfPageCount(compare.after.kind === 'present' ? compare.after.uri : null);
  const onOpen = (side: Side) => {
    const index = side === 'before' ? compare.beforeGalleryIndex : compare.afterGalleryIndex;
    if (index !== null) stage.open(compare.gallery, index);
  };
  return (
    <PdfChangeRow testID={props.testID} filePath={props.filePath} before={compare.before} after={compare.after}
      beforePages={beforePages} afterPages={afterPages} onOpen={onOpen} />
  );
}

const styles = StyleSheet.create(theme => ({
  root: {
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s8,
  },
  facts: {
    flexGrow: 1,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
