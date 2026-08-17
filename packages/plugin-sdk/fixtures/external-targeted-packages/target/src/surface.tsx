import {
  defineUiSurface,
  TargetedSurface,
  Text,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import type { ReactElement } from 'react';
import { selectPhysicalCopyDetailSurface } from './targetedSurfaceSelection.js';

export { selectPhysicalCopyDetailSurface } from './targetedSurfaceSelection.js';

function unavailableFallback(): ReactElement {
  return <Text value="External source detail unavailable" />;
}

export function PhysicalCopyTargetSurface(): ReactElement {
  const { targetedContributions } = useSurfaceContext();
  const surface = selectPhysicalCopyDetailSurface(targetedContributions);
  const fallback = unavailableFallback();
  if (surface === null) return fallback;

  return (
    <TargetedSurface
      surface={surface}
      input={{ entryId: 'external-42' }}
      instanceKey="external-42"
      fallback={fallback}
    />
  );
}

export const renderPhysicalCopyTargetSurface = defineUiSurface(PhysicalCopyTargetSurface);
