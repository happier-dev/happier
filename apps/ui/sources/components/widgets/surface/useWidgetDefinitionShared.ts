import * as React from 'react';
import { readArtifactSharedAudienceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type {
  WidgetDefinitionRefV1,
  WidgetDefinitionV1,
} from '@happier-dev/protocol/widgets';

import { useArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import {
  useActiveServerAccountScope,
  useArtifact,
} from '@/sync/domains/state/storage';

/** Copies of one saved definition on a surface share a single roster read per exact revision. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Whether someone besides its owner can see or write a saved HTML definition, from the canonical Artifact sharing
 * reader. A grant changes no revision, but an editor's write does, so each revision is read once. Undefined until
 * that read settles; a read that cannot prove privacy counts as shared.
 */
export function useWidgetDefinitionShared(
  reference: WidgetDefinitionRefV1,
  definition: WidgetDefinitionV1 | null,
): boolean | undefined {
  const client = useArtifactActionsClient();
  const scope = useActiveServerAccountScope();
  const artifactId = reference.kind === 'artifact' ? reference.artifactId : '';
  const artifact = useArtifact(artifactId);
  const key =
    client &&
    scope &&
    artifact &&
    definition?.body.kind === 'html' &&
    artifact.bodyVersion !== undefined
      ? [
          scope.serverId,
          scope.accountId,
          artifactId,
          artifact.headerVersion,
          artifact.bodyVersion,
        ].join('\u0000')
      : null;
  const row = React.useRef(artifact);
  row.current = artifact;
  const [settled, setSettled] = React.useState<Readonly<{
    key: string;
    shared: boolean;
  }> | null>(null);
  React.useEffect(() => {
    const current = row.current;
    if (!key || !client || !current) return;
    let live = true;
    let read = inFlight.get(key);
    if (!read) {
      read = readArtifactSharedAudienceV1({
        current: {
          artifactId,
          header: current.rawHeader ?? {},
          ownerAccountId: current.ownerAccountId,
          access: current.access,
          publicAudience: current.publicAudience,
        },
        readGrants: async () => {
          const outcome = await client.listAccessGrants(artifactId);
          if (!outcome.ok) throw new Error(outcome.failure.code);
          return outcome.value;
        },
      })
        .catch(() => true)
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, read);
    }
    void read.then((shared) => {
      if (live) setSettled({ key, shared });
    });
    return () => {
      live = false;
    };
  }, [artifactId, client, key]);
  return settled?.key === key ? settled.shared : undefined;
}
