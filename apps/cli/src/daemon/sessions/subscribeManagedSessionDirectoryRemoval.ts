import type { ManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { StopSessionResult } from './stopSessionContract';
import { logger } from '@/ui/logger';
import { retireRequesterSessionCredentialCustody } from '../sessionEncryption/requesterSessionCredentials';

type Unsubscribe = () => void;
type Subscribe<T> = (listener: (change: T) => void | Promise<void>) => Unsubscribe;

type CreationSessionLookup = (args: Readonly<{
  token: string;
  tags: readonly string[];
}>) => Promise<
  | Readonly<{ state: 'available'; sessions: readonly Readonly<{ id: string }>[] }>
  | Readonly<{ state: 'unavailable' }>
>;

type ManagedSessionDirectoryRemovalParams = Readonly<{
  directories: Pick<ManagedSessionDirectories,
    'listRecords' | 'bind' | 'removeForSession' | 'retryPendingRemovals'>;
  token: string;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  purgeBrowserStorageForSessionDeleted?: (sessionId: string) => Promise<void>;
  onSessionDeletedChange: Subscribe<Readonly<{ sessionId: string }>>;
  onSessionAccessReset: Subscribe<Readonly<{ cursor: number }>>;
  lookupCreationSessions?: CreationSessionLookup;
  requesterCustody?: Readonly<{
    happyHomeDir: string;
    serverId: string;
  }>;
}>;

export async function subscribeManagedSessionDirectoryRemoval(
  params: ManagedSessionDirectoryRemovalParams,
): Promise<Unsubscribe> {
  const lookupCreationSessions: CreationSessionLookup = params.lookupCreationSessions
    ?? (async (args) => {
      const { lookupSessionsByTags } = await import('@/session/transport/http/sessionsHttp');
      return await lookupSessionsByTags(args);
    });

  const retryPendingRemovals = async (): Promise<void> => {
    try {
      await params.directories.retryPendingRemovals({ stopSession: params.stopSession });
    } catch (error) {
      logger.warn('[MANAGED SESSION DIRECTORY] Pending removal retry unavailable', { error });
    }
  };

  const unsubscribes = [
    params.onSessionDeletedChange(async ({ sessionId }) => {
      // Home inactivity is not physical death: an automatic successor can still
      // own this Session, including one with an ordinary (unmanaged) directory.
      // Stop fences pending launches as well as retiring every tracked runner.
      // Keep failed cleanup inside the deletion cursor's existing replay custody.
      const stopped = await params.stopSession(sessionId);
      if (stopped.status !== 'stopped' && stopped.status !== 'not_found') {
        throw new Error('deleted_session_runner_retirement_incomplete');
      }
      // Inactive Sessions have no child-exit signal to release their Browser storage.
      await params.purgeBrowserStorageForSessionDeleted?.(sessionId);
      if (params.requesterCustody
        && !await retireRequesterSessionCredentialCustody({ ...params.requesterCustody, sessionId })) {
        throw new Error('requester_session_custody_unavailable');
      }
      await params.directories.removeForSession({ sessionId, stopSession: async () => stopped });
    }),
    params.onSessionAccessReset(retryPendingRemovals),
  ];
  const dispose = (): void => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };

  try {
    // Bootstrap runs this before the Account-change carrier connects and before
    // this daemon admits fresh spawns. Handoff abort retains its own custody.
    for (const record of await params.directories.listRecords()) {
      if (record.pendingRemoval || record.origin !== 'creation' || record.sessionId !== null || record.sessionCreationTag === null) continue;
      try {
        const lookup = await lookupCreationSessions({ token: params.token, tags: [record.sessionCreationTag] });
        if (lookup.state === 'unavailable') throw new Error('managed_session_creation_lookup_unavailable');
        if (lookup.sessions.length > 1) throw new Error('managed_session_creation_lookup_ambiguous');
        const session = lookup.sessions[0];
        if (session) {
          await params.directories.bind({ allocationId: record.allocationId, sessionId: session.id });
        }
        // A grantee owns its conversation even when it runs on this Machine.
        // This daemon Account's tag lookup cannot prove another Account's
        // creation was deleted; retain its files for normal resume binding.
      } catch (error) {
        logger.warn('[MANAGED SESSION DIRECTORY] Startup reconciliation pending', { allocationId: record.allocationId, error });
      }
    }
  } catch (error) {
    logger.warn('[MANAGED SESSION DIRECTORY] Startup cleanup unavailable', { error });
  }
  // Only a deletion event or a previously recorded removal authorizes cleanup.
  // Account inventory absence is visibility, never proof of Session deletion.
  await retryPendingRemovals();
  return dispose;
}
