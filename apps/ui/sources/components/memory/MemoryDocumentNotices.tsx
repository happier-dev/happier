import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { MemoryDocumentSource } from './useMemoryDocument';

/** A retained offline view replaces its read failure; without a view the failure keeps Retry. */
export function MemoryDocumentNotices(props: Readonly<{
  testID: string;
  offline: boolean;
  since: number | null;
  source: Pick<MemoryDocumentSource, 'view' | 'status' | 'refresh'>;
  notice: 'pending' | 'conflict' | 'refused' | null;
  onReviewConflict?: () => void;
}>) {
  const { testID, source, notice } = props;
  const showingOffline = props.offline && source.view !== null;
  return <>
    {showingOffline ? <SurfaceFreshnessLine testID={`${testID}.offline`} glyph="cloud-slash"
      asOf={props.since} reason={t('memoryContext.memory.offlineHeld')} /> : null}
    {notice === 'pending' ? <SurfaceFreshnessLine testID={`${testID}.pending`} busy
      reason={t('memoryContext.memory.pending')} />
      : notice === 'conflict' ? <SurfaceFreshnessLine testID={`${testID}.conflict`} tone="warning"
        reason={t('memoryContext.memory.conflict')}
        action={props.onReviewConflict ? { label: t('memoryContext.memory.reviewChange'), onPress: props.onReviewConflict } : undefined} />
      : notice === 'refused' && !showingOffline ? <SurfaceFreshnessLine testID={`${testID}.refused`} tone="warning"
        reason={t('memoryContext.memory.refused')} />
      : source.view?.shared === null && !showingOffline ? <SurfaceFreshnessLine
        testID={`${testID}.sharingUnknown`} tone="warning"
        reason={t('memoryContext.memory.sharingUnknownDescription')} />
      : source.status === 'unavailable' && !showingOffline ? <SurfaceFreshnessLine
        testID={`${testID}.unavailable`} tone="warning"
        reason={t(source.view ? 'memoryContext.memory.offlineStale' : 'memoryContext.memory.offline')}
        action={{ label: t('common.retry'), onPress: () => {
          fireAndForget(source.refresh(), { tag: 'MemoryDocumentBody.retry' });
        } }} /> : null}
  </>;
}
