import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * The one way a failed saved-preset read is said (the Software shelf and the listing's "Add to a preset" menu):
 * the denied or unavailable reason and its Retry, never an empty list that looks like no presets.
 */
export function StorePresetsReadFailure(props: Readonly<{ testID: string; error: string; onRetry: () => void | Promise<void> }>) {
  const denied = props.error === 'permission_denied' || props.error === 'signed_out';
  return (
    <SurfaceStateCard
      testID={props.testID}
      size="line"
      kind={denied ? 'denied' : 'unavailable'}
      title={denied ? t('machinePresets.accessLost') : t('capabilities.store.softwarePage.presetsFailed')}
      diagnosticCode={props.error}
      action={{ label: t('common.retry'), onPress: props.onRetry }}
    />
  );
}
