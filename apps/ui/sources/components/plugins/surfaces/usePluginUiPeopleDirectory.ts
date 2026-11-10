import * as React from 'react';
import type {
  HostPeopleDirectory,
  HostPeopleDirectoryRequest,
  HostPerson,
} from '@happier-dev/plugin-ui/hostApi';

import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type {
  SessionAccessCandidateRowModel,
  SessionAccessGrantOperationModel,
} from '@/components/sessions/access/sessionAccessEditorTypes';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';

const NO_OPERATIONS: Readonly<
  Record<string, SessionAccessGrantOperationModel>
> = Object.freeze({});
const NO_TEAMS = Object.freeze([]);
const ACCOUNT_ONLY = Object.freeze(['account'] as const);
const NO_ROWS: readonly SessionAccessCandidateRowModel[] = Object.freeze([]);

type Read = Readonly<{
  status: HostPeopleDirectory['status'];
  rows: readonly SessionAccessCandidateRowModel[];
}>;
const IDLE: Read = Object.freeze({ status: 'idle', rows: NO_ROWS });

function person(
  row: Pick<SessionAccessCandidateRowModel, 'principal'>,
): HostPerson | null {
  const { principal } = row;
  if (principal.ref.kind !== 'account') return null;
  return {
    accountId: principal.ref.accountId,
    name: principal.displayName,
    ...(principal.secondaryLabel === undefined
      ? {}
      : { handle: principal.secondaryLabel }),
  };
}

/**
 * The plugin-ui people directory, bound to the collaboration directory the share sheet uses: the viewer first,
 * then the Accounts they may name (accepted friends and current Team co-members), as that owner pages them. The
 * first page is read when a picker demands it and kept while it stays open; a failed read is retried on request.
 */
export function usePluginUiPeopleDirectory(
  request: HostPeopleDirectoryRequest,
): HostPeopleDirectory {
  const { enabled } = request;
  const { serverId, accountId } = request.scope;
  const scope = React.useMemo(
    () => ({ serverId, accountId }),
    [serverId, accountId],
  );
  const directory = useSessionAccessDirectory({
    scope,
    availability: 'available',
    contextTeams: NO_TEAMS,
    operations: NO_OPERATIONS,
    revision: 0,
    enabled,
    principalKinds: ACCOUNT_ONLY,
  });
  const viewerProfile = useShareViewerProfile(scope);
  const resolve = directory.sections.find(
    (section) => section.kind === 'account',
  )?.resolveCandidates;
  const [read, setRead] = React.useState<Read>(IDLE);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!enabled || resolve === undefined) return;
    const controller = new AbortController();
    setRead((previous) => ({ status: 'loading', rows: previous.rows }));
    resolve('', controller.signal).then(
      (rows) => {
        if (!controller.signal.aborted) setRead({ status: 'ready', rows });
      },
      () => {
        if (!controller.signal.aborted)
          setRead((previous) => ({ status: 'failed', rows: previous.rows }));
      },
    );
    return () => controller.abort();
  }, [enabled, resolve, attempt]);
  const retryAccounts = directory.retry;
  const retry = React.useCallback(() => {
    retryAccounts('account');
    setAttempt((current) => current + 1);
  }, [retryAccounts]);
  const people = React.useMemo(() => {
    const viewer = person({
      principal: presentSharePrincipal({
        ref: { kind: 'account', accountId },
        profile: viewerProfile,
        viewerProfile,
        viewerAccountId: accountId,
      }),
    })!;
    return [
      viewer,
      ...read.rows.flatMap((row) => {
        const candidate = person(row);
        return candidate === null || candidate.accountId === accountId
          ? []
          : [candidate];
      }),
    ];
  }, [accountId, read.rows, viewerProfile]);
  return React.useMemo(
    () => ({ status: enabled ? read.status : 'idle', people, retry }),
    [enabled, people, read.status, retry],
  );
}
