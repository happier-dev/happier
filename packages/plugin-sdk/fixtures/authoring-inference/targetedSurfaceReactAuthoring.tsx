import * as React from 'react';

import { TargetedSurface } from '@happier-dev/plugin-ui';

import type { ExternalSourceDetailSurface } from './targetedSurfaceAuthoring.js';

/**
 * Compile-only React acceptance fixture. Its handle type comes from the real
 * target-local observation traversal in `targetedSurfaceAuthoring`; this
 * component itself does not claim a loaded host mount.
 */
export function ExternalSourceDetail(
  { surface }: Readonly<{ surface: ExternalSourceDetailSurface }>,
): React.ReactElement {
  return (
    <TargetedSurface
      surface={surface}
      input={{ entryId: 'issue-42' }}
      instanceKey="issue-42"
      fallback={<span>Loading source detail</span>}
    />
  );
}

/** The structural snapshot path must not weaken static author-handle input inference. */
export function ExternalSourceDetailRejectsMismatchedInput(
  { surface }: Readonly<{ surface: ExternalSourceDetailSurface }>,
): React.ReactElement {
  return (
    <TargetedSurface
      surface={surface}
      // @ts-expect-error This target-owned detail handle accepts only its declared input.
      input={{ unexpected: true }}
    />
  );
}
