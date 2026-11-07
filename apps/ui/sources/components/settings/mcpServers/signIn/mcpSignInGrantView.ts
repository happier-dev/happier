import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { isConnectedAccountSignedOut } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import type { ConnectedAccountRevokedResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import type { McpServerSignInFact } from '../status/mcpServerStatus';

export type McpSignInView =
  | Readonly<{ state: 'not_connected' }>
  | Readonly<{ state: 'starting' }>
  | Readonly<{ state: 'revoked' }>
  | Readonly<{ state: 'did_not_finish'; diagnosticCode?: string }>
  | Readonly<{ state: 'no_machine_online' }>
  | Readonly<{ state: 'client_refused' }>
  | Readonly<{ state: 'invalid_client' }>
  | Readonly<{ state: 'signing'; authorizationUrl: string; expiresAtMs: number; clientRegistration?: 'not_needed' }>
  | Readonly<{ state: 'finishing'; machineName: string }>
  | Readonly<{ state: 'connected'; identity: string | null; scopes: readonly string[]; lastUsedAt: number | null }>
  | Readonly<{ state: 'needs_more_access'; tool?: string; scope?: string }>
  | Readonly<{ state: 'expired'; reason: 'expired' | 'address_changed' }>;

export function isMcpSignInService(service: Readonly<{ pluginId: string; localId: string }>): boolean {
  return service.pluginId === MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.pluginId && service.localId === MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.localId;
}

export function findMcpSignInGrant(profiles: readonly QualifiedConnectedAccountProfileV4[] | null | undefined, serverId: string): QualifiedConnectedAccountProfileV4 | null {
  return (profiles ?? []).find(profile => isMcpSignInService(profile.ref.service) && profile.ref.accountId === serverId) ?? null;
}

export type McpSignInGrantDiagnostics = Readonly<{
  configuration?: ReturnType<(typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1)['connectedServices.configuration.get']['parse']>;
  revoked?: ReturnType<typeof ConnectedAccountRevokedResponseV1Schema.parse>;
  unavailable?: boolean;
}>;

/** Who the sign-in is, in words a person knows (an email or a name); a provider's opaque account id is not one. */
export function mcpSignInGrantIdentity(grant: QualifiedConnectedAccountProfileV4): string | null {
  return grant.providerIdentity?.email ?? grant.displayName ?? null;
}

/** No online machine proves offline only when every supplied presence verdict is known. */
export function aggregateMcpMachineOnline(machines: readonly Readonly<{ online: boolean | null }>[]): boolean | null {
  let unknown = false;
  for (const machine of machines) {
    if (machine.online === true) return true;
    if (machine.online === null) unknown = true;
  }
  return unknown ? null : false;
}

/** The ONE projection of grant facts for the detail page, homepage and session sheet. */
export function mcpSignInGrantView(server: McpServerCatalogEntryV1, grant: QualifiedConnectedAccountProfileV4 | null, anyMachineOnline: boolean | null, diagnostics?: McpSignInGrantDiagnostics): McpSignInView | null {
  if (server.transport === 'stdio' || server.remote?.auth?.kind !== 'oauth') return null;
  const matches = (ref: QualifiedConnectedAccountProfileV4['ref']) => isMcpSignInService(ref.service) && ref.accountId === server.id;
  if (diagnostics?.revoked && matches(diagnostics.revoked.account)) return { state: 'revoked' };
  if (grant && !matches(grant.ref)) return { state: 'did_not_finish' };
  const safe = diagnostics?.configuration;
  if (grant && safe) {
    const { resource, stepUpScopes } = safe.configuration.values;
    if (safe.target.kind !== 'account' || !matches(safe.target.account)
      || safe.configuration.values.serverId !== server.id || typeof resource !== 'string') return { state: 'did_not_finish' };
    try {
      if (canonicalMcpOAuthResourceUrlV1(resource) !== canonicalMcpOAuthResourceUrlV1(server.remote.url)) return { state: 'expired', reason: 'address_changed' };
    } catch { return { state: 'did_not_finish' }; }
    if (isConnectedAccountSignedOut(grant.status)) return { state: 'expired', reason: 'expired' };
    if (safe.configuration.revision !== grant.configurationRevision || safe.configuration.status !== 'ready' || !grant.configurationReady) return { state: 'did_not_finish' };
    if (stepUpScopes !== undefined && (!Array.isArray(stepUpScopes) || stepUpScopes.some(scope => typeof scope !== 'string'))) return { state: 'did_not_finish' };
    const requested = Array.isArray(stepUpScopes) ? stepUpScopes.filter((scope): scope is string => typeof scope === 'string') : [];
    const missing = requested.filter(scope => !grant.scopes.includes(scope));
    if (missing.length) return { state: 'needs_more_access', scope: missing.join(' ') };
    return { state: 'connected', identity: mcpSignInGrantIdentity(grant), scopes: grant.scopes, lastUsedAt: grant.lastUsedAt ?? null };
  }
  if (anyMachineOnline === false) return { state: 'no_machine_online' };
  if (!grant) return { state: 'not_connected' };
  if (isConnectedAccountSignedOut(grant.status)) return { state: 'expired', reason: 'expired' };
  // Profile ids alone cannot establish the resource binding. The existing loading state covers this read.
  return diagnostics?.unavailable ? { state: 'did_not_finish' } : { state: 'starting' };
}

export function mcpSignInFact(view: McpSignInView | null): McpServerSignInFact {
  if (!view) return null;
  switch (view.state) {
    case 'starting': case 'signing': case 'finishing': return { state: 'signing' };
    case 'expired': return { state: 'expired', reason: view.reason };
    case 'needs_more_access': return { state: 'needs_more_access' };
    default: return { state: view.state };
  }
}
