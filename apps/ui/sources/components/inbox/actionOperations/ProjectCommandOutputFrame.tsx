import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

/** The embedded Project output inset and clipping; the shared card owns its material and shape. */
export function ProjectCommandOutputFrame(props: Readonly<{ children: ReactNode }>) {
  return <SurfaceCard padding="none" style={styles.frame}>{props.children}</SurfaceCard>;
}

const styles = StyleSheet.create({
  frame: {
    width: 'auto',
    marginHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
    marginBottom: 12,
    overflow: 'hidden',
  },
});
