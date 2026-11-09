import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { isDeepStrictEqual } from 'node:util';
import { hasStoredSessionCredentialProvenance, readStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { selectHostAccountExecutionIdentityForSession } from '../agentIsolation/agentIsolationAccountCustody';
import type { HostRequesterExecutionIdentityInput } from '../agentIsolation/agentIsolationLaunchPolicy';
import type { RequesterAccountActionCustody } from './requesterAccountActionProjection';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import {
  readRequesterSessionExecutionCustodyForHost,
  resolveRequesterSessionExecutionIdentityForHost,
} from './requesterSessionCredentials';

type OrdinaryRequesterSessionAccountCustody = RequesterAccountActionCustody
  & Required<Pick<RequesterAccountActionCustody, 'getBoundSessionId'>>;

/** A new ordinary launch captures today's sign-in, not the daemon's startup
 * bearer. Home still qualifies the exact Machine/Session; the bound Account
 * cannot change, and the captured sign-in stays exact through admission. */
export async function captureOrdinaryRequesterSessionAccountCustodyForHost(
  input: Omit<Parameters<typeof readOrdinaryRequesterSessionAccountCustodyForHost>[0], 'captured'>,
): Promise<OrdinaryRequesterSessionAccountCustody | null> {
  input.signal?.throwIfAborted();
  const credentials = await readStoredCredentialsForServerId(input.serverId);
  const accountId = input.sessionCustodianAccountId ?? readAccountIdFromToken(input.credentials.token);
  if (!credentials || !accountId || readAccountIdFromToken(credentials.token) !== accountId) return null;
  const custody = await readOrdinaryRequesterSessionAccountCustodyForHost({ ...input, credentials,
    isCurrent: async () => await input.isCurrent()
      && sameStoredCredentials(credentials, await readStoredCredentialsForServerId(input.serverId)),
  });
  return custody?.attribution.accountId === accountId ? custody : null;
}

/** Ordinary Account custody is available only for the independently qualified
 * physical owner and exact Session, with literal absence of private birth.
 * Failed retained recovery never becomes ordinary global sign-in. */
export async function readOrdinaryRequesterSessionAccountCustodyForHost(
  input: Omit<Parameters<typeof resolveRequesterSessionExecutionIdentityForHost>[0], 'runtimeContext'> & Readonly<{
    /** Already-fetched exact owner row and admitted physical host facts. Never
     * a caller DTO, metadata inference, or permission to replace private birth. */
    captured?: Readonly<{ session: RawSessionRecord; homeServerIdentityId: string;
      hostAccountAgent: NonNullable<HostRequesterExecutionIdentityInput['hostAccountAgent']> }>;
  }>,
): Promise<OrdinaryRequesterSessionAccountCustody | null> {
  input.signal?.throwIfAborted();
  const captured = input.captured;
  if (captured && ('requesterSessionCredentialScope' in input.credentials
    || !hasStoredSessionCredentialProvenance(input.credentials)
    || captured.homeServerIdentityId !== input.hostHomeServerIdentityId
    || captured.hostAccountAgent.machineId !== input.machineId
    || captured.hostAccountAgent.custodianAccountId !== input.sessionCustodianAccountId
    || readAccountIdFromToken(input.credentials.token) !== captured.hostAccountAgent.accountId
    || !await input.isCurrent())) return null;
  const identity = captured ? selectHostAccountExecutionIdentityForSession({ kind: 'agent',
    hostAccount: captured.hostAccountAgent, hostHomeServerIdentityId: input.hostHomeServerIdentityId,
    sessionId: input.sessionId, session: captured.session })
    : await resolveRequesterSessionExecutionIdentityForHost({ ...input, runtimeContext: null });
  if (identity.kind !== 'isolated' || identity.separationRequired || !input.hostHomeServerIdentityId) return null;
  const attribution = { ...identity.requester, serverId: input.serverId };
  if (input.attribution && !isDeepStrictEqual(input.attribution, attribution)) return null;
  if (await readRequesterSessionExecutionCustodyForHost({ happyHomeDir: input.happyHomeDir,
    sessionId: input.sessionId, attribution, credentials: input.credentials,
    homeServerIdentityId: input.hostHomeServerIdentityId }) !== 'absent'
    || readInstallationIdentityIfExistsSync()?.installationId !== attribution.installationId
    || !await input.isCurrent()) return null;
  return Object.freeze({ credentials: input.credentials, attribution, serverHttpBaseUrl: input.serverHttpBaseUrl,
    isCurrent: async () => await input.isCurrent(), getBoundSessionId: () => input.sessionId });
}

/** Borrow the exact ordinary Session Account, never the focused daemon Account.
 * Private birth and guest custody remain the requester runtime's responsibility. */
export async function readOrdinaryRequesterSessionAccountOperationContextForHost(
  input: Parameters<typeof readOrdinaryRequesterSessionAccountCustodyForHost>[0],
): Promise<SavedSecretOperationContextV1 | null> {
  const custody = await readOrdinaryRequesterSessionAccountCustodyForHost(input);
  if (!custody) return null;
  // An invocation owns this snapshot's secret material and its retirement.
  // Borrowing the active snapshot would let cleanup zero another reader's keys.
  const snapshot = await runWithServerHttpBaseUrl(custody.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
    credentials: custody.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
    honorAccountSettingsModeEnv: false, allowCacheFallback: false,
    ...(input.signal ? { signal: input.signal } : {}),
  }));
  return createInvocationSavedSecretOperationContextV1({ credentials: custody.credentials, snapshot,
    serverHttpBaseUrl: custody.serverHttpBaseUrl,
    machineAdmission: { actorAccountId: custody.attribution.accountId,
      custodianAccountId: custody.attribution.accountId, role: 'manage' },
    isCurrent: custody.isCurrent,
  });
}
