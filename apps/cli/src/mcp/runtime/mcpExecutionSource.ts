import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

import { readPublishedMachineRow } from '@/api/machine/readPublishedMachineRow';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { hasStoredSessionCredentialProvenance, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { isHostRequesterUnrestrictedOwner, selectHostRequesterExecutionIdentity, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { readHostAccountExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationAccountCustody';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';

export type McpExecutionSource =
  | Readonly<{ kind: 'local_user' }>
  | Readonly<{ kind: 'requester'; identity: HostRequesterExecutionIdentity; credentials?: StoredCredentials;
      hostHomeServerIdentityId?: string }>;

export function refuseMcpExecutionSource(reason: Extract<HostRequesterExecutionIdentity, { kind: 'unknown' }>['reason']
  | 'agent_launch_kind_unavailable'): never {
  try {
    logger.warnLocalFile('[MCP] Execution admission refused', { code: 'agent_isolation_unavailable', reason,
      launchKind: 'mcp_stdio', phase: 'mcp_execution_admission' });
  } catch { /* File diagnostics cannot replace the original no-effect refusal. */ }
  // Both the Plugin ABI and the existing Machine RPC transport must retain the
  // same closed refusal code. The transport reads its own rpcErrorCode carrier.
  throw Object.assign(new PluginError({ code: 'agent_isolation_unavailable',
    message: 'MCP execution cannot use the current requester transport', retryable: false,
    details: { reason, launchKind: 'mcp_stdio' } }), { rpcErrorCode: 'agent_isolation_unavailable' });
}

/** Qualify the captured source's custody once at its parent owner. Transport
 * admission remains below; this does not grant an unsupported stdio launch. */
export async function qualifyMcpExecutionSourceForHost(source: McpExecutionSource, signal?: AbortSignal): Promise<McpExecutionSource> {
  signal?.throwIfAborted();
  if (source.kind !== 'requester') return source;
  if (source.identity.kind === 'unknown') return refuseMcpExecutionSource(source.identity.reason);
  if (source.identity.kind !== 'isolated' || !source.identity.separationRequired) return source;
  const credentials = source.credentials;
  const scope = credentials?.requesterSessionCredentialScope;
  if (!credentials || !scope) return source;
  const requester = source.identity.requester;
  const hostHomeServerIdentityId = source.hostHomeServerIdentityId;
  if (!hostHomeServerIdentityId) return refuseMcpExecutionSource('requester_authority_unavailable');
  const row = await runWithServerHttpBaseUrl(scope.serverHttpBaseUrl, () =>
    readPublishedMachineRow(requester.machineId, credentials, { signal }))
    .catch(() => { signal?.throwIfAborted(); return refuseMcpExecutionSource('requester_authority_unavailable'); });
  signal?.throwIfAborted();
  if (!row || row.id !== requester.machineId || row.installationId !== requester.installationId
    || row.revokedAt != null || row.replacedByMachineId != null || row.access?.accessState !== 'ready') {
    return refuseMcpExecutionSource('requester_authority_unavailable');
  }
  const identity = selectHostRequesterExecutionIdentity({ sessionRequester: requester,
    sessionRequesterHomeServerIdentityId: scope.requesterSession?.homeServerIdentityId,
    hostHomeServerIdentityId, sessionCustodianAccountId: row.access.custodian.accountId });
  if (identity.kind === 'unknown') return refuseMcpExecutionSource(identity.reason);
  return { ...source, identity };
}

/** Account material is selected only after its existing private custody is known. */
export async function readMcpExecutionSource(input: Readonly<{
  credentials: StoredCredentials | null | undefined;
  catalogCredentials?: StoredCredentials | null;
  sessionId?: string;
  machineId?: string;
  serverHttpBaseUrl?: string;
  /** In-memory fact supplied only by a direct local CLI composition owner. */
  localWorkflow?: boolean;
  /** Held only by the Account Session composition, never parsed Session input. */
  accountSession?: Readonly<{ serverId: string; homeServerIdentityId: string | null | undefined; isCurrent(): boolean }>;
  /** Closed local API command, never a Session/Agent provenance substitution. */
  accountAutomation?: Readonly<{ homeServerIdentityId: string | null | undefined; isCurrent(): boolean }>;
  signal?: AbortSignal;
}>): Promise<McpExecutionSource> {
  input.signal?.throwIfAborted();
  const credentials = input.credentials;
  const scope = credentials?.requesterSessionCredentialScope;
  const hasRequesterScope = !!credentials && 'requesterSessionCredentialScope' in credentials;
  const custody = scope?.requesterSession;
  if (!custody) {
    if (input.accountAutomation && input.accountSession) return refuseMcpExecutionSource('requester_authority_unavailable');
    if (credentials && input.localWorkflow === true && !hasRequesterScope && hasStoredSessionCredentialProvenance(credentials)
      && (input.catalogCredentials === undefined || sameStoredCredentials(credentials, input.catalogCredentials))) {
      return { kind: 'local_user' };
    }
    const accountAutomation = input.localWorkflow === true ? input.accountAutomation : undefined;
    const accountBinding = accountAutomation ?? input.accountSession;
    if (input.accountSession && !input.sessionId) return refuseMcpExecutionSource('session_requester_unavailable');
    const identity = await readHostAccountExecutionIdentity({ credentials, catalogCredentials: input.catalogCredentials,
      kind: accountAutomation ? 'automation' : 'agent', machineId: input.machineId,
      hostHomeServerIdentityId: accountBinding?.homeServerIdentityId, serverHttpBaseUrl: input.serverHttpBaseUrl,
      ...(input.accountSession ? { exactSession: { sessionId: input.sessionId!, serverId: input.accountSession.serverId,
        happyHomeDir: configuration.happyHomeDir } } : {}),
      isCurrent: () => accountBinding?.isCurrent() === true, signal: input.signal });
    if (credentials && accountBinding?.homeServerIdentityId
      && (accountAutomation ? isHostRequesterUnrestrictedOwner(identity) : identity.kind === 'isolated' && !identity.separationRequired)) {
      return { kind: 'requester', identity, credentials, hostHomeServerIdentityId: accountBinding.homeServerIdentityId };
    }
    return refuseMcpExecutionSource('requester_authority_unavailable');
  }
  if (!scope || !credentials || scope.serverId !== custody.attribution.serverId
    || (input.sessionId !== undefined && custody.sessionId !== input.sessionId)
    || (input.machineId !== undefined && custody.attribution.machineId !== input.machineId)
    || (input.serverHttpBaseUrl !== undefined
      && normalizeServerHttpBaseUrl(input.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(scope.serverHttpBaseUrl))
    || (input.catalogCredentials !== undefined && !isDeepStrictEqual(
      custody, input.catalogCredentials?.requesterSessionCredentialScope?.requesterSession))) {
    return refuseMcpExecutionSource('session_requester_unavailable');
  }
  const birth = { sessionRequester: custody.attribution,
    sessionRequesterHomeServerIdentityId: custody.homeServerIdentityId };
  const retainedIdentity = selectHostRequesterExecutionIdentity(birth);
  if (retainedIdentity.kind === 'unknown') return refuseMcpExecutionSource(retainedIdentity.reason);
  // The profile handle locates today's exact binding. It can verify the
  // retained birth Home, never manufacture a Home for historical custody.
  const hostHomeServerIdentityId = await resolveServerProfileHomeIdentityId(scope.serverId);
  input.signal?.throwIfAborted();
  const identity = selectHostRequesterExecutionIdentity({ ...birth, hostHomeServerIdentityId });
  if (identity.kind === 'unknown') return refuseMcpExecutionSource(identity.reason);
  return { kind: 'requester', identity, credentials,
    ...(hostHomeServerIdentityId ? { hostHomeServerIdentityId } : {}) };
}

/** Direct servers and remote bridges both use SDK stdio, without framed stdin
 * or cross-UID child custody. Authored bridge env can also select executable code. */
export async function assertMcpStdioExecutionSupported(source: McpExecutionSource, isolationEnabled?: boolean,
  signal?: AbortSignal): Promise<McpExecutionSource> {
  signal?.throwIfAborted();
  if (source.kind === 'local_user' && isolationEnabled !== true) return source;
  if (source.kind === 'requester') {
    if (source.identity.kind === 'unknown') return refuseMcpExecutionSource(source.identity.reason);
    if (isHostRequesterUnrestrictedOwner(source.identity)) return source;
    if (isolationEnabled === false) {
      const qualified = await qualifyMcpExecutionSourceForHost(source, signal);
      if (qualified.kind === 'requester' && qualified.identity.kind === 'isolated' && !qualified.identity.separationRequired) return qualified;
    }
  }
  return refuseMcpExecutionSource('agent_launch_kind_unavailable');
}
