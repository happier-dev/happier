import * as React from 'react';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';

import { useArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import {
  readArtifactAudience,
  type ArtifactAudience,
} from '@/sync/domains/artifacts/artifactAudience';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * Who an Artifact is shared with, for its page header: its own grant roster through the one audience projection Docs
 * use. A grant changes no Artifact revision, so the Account wake naming this Artifact is what reads it again. Unknown
 * (`null`) until read or when the roster cannot be read; never an empty audience. Only the identity and the access facts
 * the projection decides on re-read it; a body or title edit does not.
 */
export function useArtifactAudience(
  current: ArtifactSharingResourceV1 | null,
): ArtifactAudience | null {
  const client = useArtifactActionsClient();
  const homeId = useActiveServerAccountScope()?.serverId ?? null;
  const artifactId = current?.artifactId ?? null;
  const [wake, setWake] = React.useState(0);
  const [audience, setAudience] = React.useState<Readonly<{
    key: string;
    value: ArtifactAudience | null;
  }> | null>(null);
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const readKey = current
    ? JSON.stringify([
        current.artifactId,
        current.access ?? null,
        current.publicAudience ?? null,
        current.ownerAccountId ?? null,
      ])
    : null;
  React.useEffect(() => {
    if (!homeId || !artifactId) return;
    return subscribeHomeAccountChange(
      (event) => {
        if (event.changeKinds && !event.changeKinds.includes('artifact'))
          return;
        if (event.entityIds && !event.entityIds.includes(artifactId)) return;
        setWake((value) => value + 1);
      },
      { serverIds: [homeId] },
    );
  }, [homeId, artifactId]);
  React.useEffect(() => {
    const resource = currentRef.current;
    if (!client || !resource || !artifactId) return;
    const controller = new AbortController();
    void readArtifactAudience({
      current: resource,
      signal: controller.signal,
      readGrants: async () => {
        const outcome = await client.listAccessGrants(artifactId);
        if (!outcome.ok) throw new Error(outcome.failure.code);
        return outcome.value;
      },
    }).then(
      (value) => {
        // A failed refresh keeps the last audience it read.
        if (!controller.signal.aborted && value)
          setAudience({ key: artifactId, value });
      },
      () => {},
    );
    return () => controller.abort();
  }, [client, artifactId, readKey, wake]);
  return audience?.key === artifactId ? audience.value : null;
}
