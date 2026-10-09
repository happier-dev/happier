import * as React from 'react';
import { View } from 'react-native';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * A pane whose source body is presented by the floating viewer right now. One body, one place:
 * the pane says where it is and offers to dock it here, rather than binding a second presentation.
 */
export function SessionViewerPresentedElsewhere(
  props: Readonly<{ source: SessionViewerSource; testID?: string }>,
): React.ReactElement {
  const controller = useOptionalSessionViewerController();
  const apply = controller?.apply;
  const dock = React.useCallback(() => {
    apply?.({ kind: 'viewer.dock' });
  }, [apply]);
  return (
    <View
      style={{ flex: 1, justifyContent: 'center' }}
      testID={
        props.testID
          ? `${props.testID}-presented-elsewhere`
          : 'session-viewer-presented-elsewhere'
      }
    >
      <SurfaceStateCard
        kind="empty"
        iconName={props.source === 'computer' ? 'desktop' : 'globe'}
        title={t('computerUse.viewer.presentedElsewhereTitle')}
        reason={t('computerUse.viewer.presentedElsewhereBody')}
        action={{ label: t('computerUse.viewer.dockView'), onPress: dock }}
      />
    </View>
  );
}
