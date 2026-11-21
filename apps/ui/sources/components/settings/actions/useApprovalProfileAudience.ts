import * as React from 'react';

import { useArtifactAudience } from '@/components/artifacts/useArtifactAudience';
import type { ArtifactAudience } from '@/sync/domains/artifacts/artifactAudience';

/** Who an owned approval profile is shared with: the profile Artifact's audience through the shared Artifact owner. */
export function useApprovalProfileAudience(
  profileId: string | null,
): ArtifactAudience | null {
  const current = React.useMemo(() => profileId ? { artifactId: profileId, header: {}, access: 'owner' as const } : null, [profileId]);
  return useArtifactAudience(current);
}
