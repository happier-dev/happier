import * as React from 'react';
import {
  readSessionApprovalConsentsArtifactV1,
  SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
  type SessionApprovalConsentModeChangeV1,
  type SessionApprovalConsentRowV1,
} from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { sync } from '@/sync/sync';
import { useAccountSettingsScope } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/** Loading, a settled list (possibly empty), or unavailable: three states, never inferred from absence. */
export type SessionApprovalConsentsState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'ready'; rows: readonly SessionApprovalConsentRowV1[] }>;

const LOADING: SessionApprovalConsentsState = Object.freeze({
  status: 'loading',
});
const UNAVAILABLE: SessionApprovalConsentsState = Object.freeze({
  status: 'unavailable',
});
const EMPTY: SessionApprovalConsentsState = Object.freeze({
  status: 'ready',
  rows: Object.freeze([]),
});

type ArtifactRows = Readonly<{
  artifacts: Readonly<Record<string, DecryptedArtifact>>;
  artifactInventoryIndex: ReadonlyMap<string, ReadonlySet<string>>;
}>;

/** The Session's record, found through its Session-relationship index bucket (no Account-wide scan). */
export function selectSessionApprovalConsentsArtifact(
  state: ArtifactRows,
  sessionId: string,
): DecryptedArtifact | undefined {
  const ids = state.artifactInventoryIndex.get(
    JSON.stringify(['session', sessionId]),
  );
  let selected: DecryptedArtifact | undefined;
  for (const id of ids ?? []) {
    const artifact = state.artifacts[id];
    const kind = artifact?.rawHeader?.kind ?? artifact?.header?.kind;
    // The lowest id is the record every host reads and writes (sessionApprovalConsentsV1).
    if (
      artifact &&
      !artifact.draft &&
      kind === SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 &&
      (!selected || artifact.id < selected.id)
    )
      selected = artifact;
  }
  return selected;
}

/**
 * Session › Allowed and the approval sheet: the Session's own "allow for this Session" rows, read
 * from the store through a key-scoped subscription, plus the person's writes through the policy
 * Action (a person's own write is saved without a second confirmation).
 */
export function useSessionApprovalConsents(
  target: SessionAddress | null | undefined,
) {
  const serverId = target?.serverId ?? null;
  const sessionId = target?.sessionId ?? null;
  const scope = useAccountSettingsScope();
  const profilesGeneration = useServerProfilesGeneration();
  const [census, setCensus] = React.useState<Readonly<{
    key: string;
    outcome: 'success' | 'failed';
  }> | null>(null);
  const key = JSON.stringify([
    scope?.serverId,
    scope?.accountId,
    serverId,
    sessionId,
  ]);
  React.useEffect(() => {
    if (
      !scope ||
      !serverId ||
      !sessionId ||
      !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)
    )
      return;
    return sync.observeArtifactInventory(
      scope,
      { approvalSessionIds: [sessionId] },
      {
        refreshOnAdmission: true,
        // A later failed refresh keeps the last settled list.
        onSettled: (outcome) =>
          setCensus((prior) =>
            prior?.key === key &&
            prior.outcome === 'success' &&
            outcome === 'failed'
              ? prior
              : { key, outcome },
          ),
      },
    );
  }, [key, profilesGeneration]);
  const artifact = getStorage()((state) =>
    sessionId
      ? selectSessionApprovalConsentsArtifact(state, sessionId)
      : undefined,
  );
  const needsBody = artifact !== undefined && artifact.body === undefined;
  React.useEffect(() => {
    if (needsBody && serverId && artifact)
      void sync.hydrateSessionApprovalArtifacts(serverId, [artifact.id]);
  }, [needsBody, serverId, artifact?.id]);
  const state = React.useMemo((): SessionApprovalConsentsState => {
    if (!sessionId) return UNAVAILABLE;
    if (artifact) {
      if (artifact.body === undefined) return LOADING;
      // The exact opened header; the presentation header is not storage metadata.
      const header = artifact.rawHeader;
      const read =
        header && typeof artifact.body === 'string'
          ? readSessionApprovalConsentsArtifactV1(
              {
                artifactId: artifact.id,
                header,
                body: artifact.body,
                ...(artifact.access ? { access: artifact.access } : {}),
                revision: {
                  headerVersion: artifact.headerVersion,
                  bodyVersion: artifact.bodyVersion ?? 0,
                },
              },
              sessionId,
            )
          : null;
      // An unreadable record applies no rows on the Machine either: present it as unavailable.
      return read ? { status: 'ready', rows: read.rows } : UNAVAILABLE;
    }
    if (census?.key !== key) return LOADING;
    return census.outcome === 'success' ? EMPTY : UNAVAILABLE;
  }, [artifact, census, key, sessionId]);

  const execution = useMountedActionExecution(serverId);
  const execute = execution.execute;
  /** Add or change one row; mode `default` removes it. */
  const setRow = React.useCallback(
    (change: SessionApprovalConsentModeChangeV1) =>
      sessionId
        ? execute('actions.policy.set', {
            actionId: change.actionId,
            audience: change.audience,
            session: { sessionId },
            ...(change.scope ? { scope: change.scope } : {}),
            mode: change.mode,
          })
        : Promise.resolve({
            ok: false as const,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
          }),
    [execute, sessionId],
  );
  return { state, setRow, ready: execution.ready };
}
