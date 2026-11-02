import { connect } from '@happier-dev/sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { readPublishedMachineRow, readPublishedMachineRowWithLegacyOwnerProof } from '@/api/machine/readPublishedMachineRow';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { hasStoredSessionCredentialProvenance, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { selectHostRequesterExecutionIdentity, type HostRequesterExecutionIdentity,
  type HostRequesterExecutionIdentityInput } from './agentIsolationLaunchPolicy';

/** The HTTP producer and already-admitted receiver qualify the same exact raw
 * Session. Captured rows never mint Account/Machine custody or private birth. */
export function selectHostAccountExecutionIdentityForSession(input: Readonly<{
  kind: 'agent' | 'automation';
  hostAccount: NonNullable<HostRequesterExecutionIdentityInput['hostAccountAgent']>;
  hostHomeServerIdentityId: string | null | undefined;
  sessionId: string;
  session: RawSessionRecord | null;
}>): HostRequesterExecutionIdentity {
  if (!input.sessionId || !input.session || input.session.id !== input.sessionId
    || readSessionAccessProjectionRoleV1(input.session) !== 'owner') {
    return { kind: 'unknown', reason: 'session_requester_unavailable' };
  }
  return selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: input.hostHomeServerIdentityId,
    ...(input.kind === 'automation' ? { hostAccountAutomation: input.hostAccount } : { hostAccountAgent: input.hostAccount }) });
}

/** Shared authenticated Account/Machine facts. This neither establishes Session
 * birth nor grants person presence; the Session custody owner proves its source. */
export async function readHostAccountExecutionIdentity(input: Readonly<{
  credentials: StoredCredentials | null | undefined;
  catalogCredentials: StoredCredentials | null | undefined;
  kind: 'agent' | 'automation';
  machineId: string | null | undefined;
  hostHomeServerIdentityId: string | null | undefined;
  serverHttpBaseUrl: string | null | undefined;
  /** Ordinary Session custody additionally proves this exact Session belongs
   * to the captured Account. Machine-only composition omits this fact. */
  exactSession?: Readonly<{ sessionId: string; serverId: string; happyHomeDir: string }>;
  isCurrent(): boolean | Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<HostRequesterExecutionIdentity> {
  const unavailable = (): HostRequesterExecutionIdentity => ({ kind: 'unknown', reason: 'requester_authority_unavailable' });
  input.signal?.throwIfAborted();
  try {
    const credentials = input.credentials;
    if (!credentials || 'requesterSessionCredentialScope' in credentials
      || input.catalogCredentials !== undefined && !sameStoredCredentials(credentials, input.catalogCredentials)
      || !(input.kind === 'automation' ? credentials.credentialProvenance === 'api_token'
        : hasStoredSessionCredentialProvenance(credentials))
      || !input.hostHomeServerIdentityId || !input.machineId || !input.serverHttpBaseUrl || !await input.isCurrent()) return unavailable();
    const installation = readInstallationIdentityIfExistsSync();
    if (!installation) return unavailable();
    const accountId = input.kind === 'automation' ? await (async () => {
      const client = connect({ endpoint: input.serverHttpBaseUrl!, token: credentials.token });
      try { return (await client.apiTokens.self({ signal: input.signal })).accountId; }
      finally { await client.close(); }
    })() : readAccountIdFromToken(credentials.token);
    if (!accountId || !await input.isCurrent()) return unavailable();
    const observation = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => input.kind === 'automation'
      ? { row: await readPublishedMachineRow(input.machineId!, credentials, { signal: input.signal }), legacyOwnerOnly: false }
      : readPublishedMachineRowWithLegacyOwnerProof(input.machineId!, credentials, { signal: input.signal }));
    const row = observation?.row;
    const legacyOwnerOnly = input.kind === 'agent' && observation?.legacyOwnerOnly === true;
    input.signal?.throwIfAborted();
    if (!row || !await input.isCurrent() || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId
      || row.id !== input.machineId || row.installationId !== installation.installationId
      || row.revokedAt != null || row.replacedByMachineId != null
      || !legacyOwnerOnly && row.access?.accessState !== 'ready') return unavailable();
    const custodianAccountId = legacyOwnerOnly ? accountId : row.access?.custodian.accountId;
    if (!custodianAccountId) return unavailable();
    const custody = { accountId, machineId: row.id, installationId: installation.installationId, custodianAccountId };
    if (input.exactSession !== undefined) {
      const exactSession = input.exactSession;
      if (!exactSession.sessionId || !exactSession.serverId || !exactSession.happyHomeDir) return unavailable();
      const { readRequesterSessionExecutionCustodyForHost } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
      if (await readRequesterSessionExecutionCustodyForHost({ ...exactSession,
        attribution: { serverId: exactSession.serverId, accountId, machineId: row.id, installationId: installation.installationId },
        credentials, homeServerIdentityId: input.hostHomeServerIdentityId }) === 'unavailable') return unavailable();
      const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
      const session = await fetchSessionById({ token: credentials.token, sessionId: exactSession.sessionId,
        serverUrl: input.serverHttpBaseUrl, reason: 'requester-binding', signal: input.signal }).catch(async error => {
        // Preserve the Session custody owner's retryable Home-read disposition;
        // a temporary read failure does not prove ownership or revocation.
        const { rethrowRequesterHomeReadFailure } = await import('@/daemon/sessionEncryption/requesterCurrentness');
        rethrowRequesterHomeReadFailure(error);
        return null;
      });
      input.signal?.throwIfAborted();
      if (!await input.isCurrent() || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) return unavailable();
      return selectHostAccountExecutionIdentityForSession({ kind: input.kind, hostAccount: custody,
        hostHomeServerIdentityId: input.hostHomeServerIdentityId, sessionId: exactSession.sessionId, session });
    }
    return selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: input.hostHomeServerIdentityId,
      ...(input.kind === 'automation' ? { hostAccountAutomation: custody } : { hostAccountAgent: custody }) });
  } catch (error) {
    input.signal?.throwIfAborted();
    if (isPluginError(error) && error.code === 'project_requester_home_unavailable') throw error;
    return unavailable();
  }
}
