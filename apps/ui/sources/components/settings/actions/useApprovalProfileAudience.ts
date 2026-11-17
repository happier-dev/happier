import * as React from 'react';

import { useArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import {
  readArtifactAudience,
  type ArtifactAudience,
} from '@/sync/domains/artifacts/artifactAudience';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * Who an owned approval profile is shared with, for its page header: the profile Artifact's own grant roster through
 * the one audience projection Docs use. A grant changes no profile revision, so the Account wake naming this profile
 * is what reads it again. Unknown (`null`) until read or when the roster cannot be read; never an empty audience.
 */
export function useApprovalProfileAudience(
  profileId: string | null,
): ArtifactAudience | null {
  const client = useArtifactActionsClient();
  const homeId = useActiveServerAccountScope()?.serverId ?? null;
  const [wake, setWake] = React.useState(0);
  const [audience, setAudience] = React.useState<Readonly<{
    key: string;
    value: ArtifactAudience | null;
  }> | null>(null);
  React.useEffect(() => {
    if (!homeId || !profileId) return;
    return subscribeHomeAccountChange(
      (event) => {
        if (event.changeKinds && !event.changeKinds.includes('artifact'))
          return;
        if (event.entityIds && !event.entityIds.includes(profileId)) return;
        setWake((value) => value + 1);
      },
      { serverIds: [homeId] },
    );
  }, [homeId, profileId]);
  React.useEffect(() => {
    if (!client || !profileId) return;
    const controller = new AbortController();
    void readArtifactAudience({
      current: { artifactId: profileId, header: {}, access: 'owner' },
      signal: controller.signal,
      readGrants: async () => {
        const outcome = await client.listAccessGrants(profileId);
        if (!outcome.ok) throw new Error(outcome.failure.code);
        return outcome.value;
      },
    }).then(
      (value) => {
        // A failed refresh keeps the last audience it read.
        if (!controller.signal.aborted && value)
          setAudience({ key: profileId, value });
      },
      () => {},
    );
    return () => controller.abort();
  }, [client, profileId, wake]);
  return audience?.key === profileId ? audience.value : null;
}
