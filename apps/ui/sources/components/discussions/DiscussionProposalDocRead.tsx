import * as React from 'react';

import type { AdmittedDocRead } from '@/components/artifacts/ArtifactEditProposal';
import type { ArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

export const LOADING_PROPOSAL_DOC: AdmittedDocRead = Object.freeze({ status: 'loading' });

export type ReportProposalDocRead = (
  artifactId: string,
  client: ArtifactActionsClient,
  read: AdmittedDocRead | null,
) => void;

/** One admitted current Doc basis for the shown cards that refer to it, in this Discussion's Home. */
export function DiscussionProposalDocRead(
  props: Readonly<{
    artifactId: string;
    client: ArtifactActionsClient;
    accountLifetime: ServerAccountScopeLifetime;
    onRead: ReportProposalDocRead;
  }>,
) {
  const { artifactId, client, accountLifetime, onRead } = props;
  const revisionKey = getStorage()((state) => {
    if (!areServerAccountScopesEqual(state.profileScope, client.scope)) return '';
    const artifact = state.artifacts[artifactId];
    return artifact
      ? JSON.stringify([
          artifact.headerVersion,
          artifact.bodyVersion,
          artifact.seq,
          artifact.access,
          artifact.ownerAccountId,
          artifact.publicAudience,
        ])
      : '';
  });
  const [wake, setWake] = React.useState<object | null>(null);
  React.useEffect(
    () =>
      subscribeHomeAccountChange((event) => {
        if (
          !areServerProfileIdentifiersEquivalent(
            event.serverId,
            client.scope.serverId,
          ) ||
          (event.changeKinds && !event.changeKinds.includes('artifact')) ||
          (event.entityIds && !event.entityIds.includes(artifactId))
        )
          return;
        setWake(event);
      }, { reconnect: 'refresh' }),
    [artifactId, client],
  );
  React.useEffect(() => {
    let current = true;
    const retirement = accountLifetime.onRetire(() => {
      current = false;
      onRead(artifactId, client, { status: 'unavailable' });
    });
    if (accountLifetime.isCurrent()) {
      void client.readDoc({ ref: { kind: 'doc', artifactId } }).then((outcome) => {
        if (!current || !accountLifetime.isCurrent()) return;
        onRead(
          artifactId,
          client,
          outcome.ok
            ? { status: 'ready', value: outcome.value }
            : { status: 'unavailable' },
        );
      });
    } else onRead(artifactId, client, { status: 'unavailable' });
    return () => {
      current = false;
      retirement.dispose();
    };
  }, [accountLifetime, artifactId, client, onRead, revisionKey, wake]);
  React.useEffect(
    () => () => onRead(artifactId, client, null),
    [artifactId, client, onRead],
  );
  return null;
}
