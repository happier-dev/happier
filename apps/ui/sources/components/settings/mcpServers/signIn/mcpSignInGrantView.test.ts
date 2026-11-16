import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { mcpSignInFact, mcpSignInGrantView, type McpSignInGrantDiagnostics } from './mcpSignInGrantView';

const ref = { service: { pluginId: 'happier', localId: 'mcp-sign-in' }, accountId: 'linear' };
const server = McpServerCatalogEntryV1Schema.parse({ id: ref.accountId, name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {}, auth: { kind: 'oauth' } } });
const grant = { ref, status: 'connected', authenticationModeId: 'oauth', configurationReady: true,
  configurationRevision: 'configuration-1', kind: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', scopes: ['read'] } satisfies QualifiedConnectedAccountProfileV4;

// Safe host MCP runtime fields (mcpSignInRuntime.ts descriptor), in configuration.get's existing
// output. The adjacent producer suite also exercises the real Action and its strict schema.
function configuration(resource = server.remote!.url, stepUpScopes: string[] = []): NonNullable<McpSignInGrantDiagnostics['configuration']> {
  return { target: { kind: 'account', account: ref, modeId: 'oauth' },
    mode: { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://cloud.happier.dev/oauth/mcp/callback', pkce: 'required', outcomeReconciliation: 'none' },
    configuration: { status: 'ready', revision: 'configuration-1', values: { serverId: server.id, resource, grantedScopes: grant.scopes, stepUpScopes }, configuredSecretFieldIds: [], missingFieldIds: [] } };
}

describe('the shared MCP grant/status projection', () => {
  it('keeps factual grant absence and diagnostics when presence is unknown without inventing a sign-in', () => {
    expect(mcpSignInGrantView(server, null, null)).toEqual({ state: 'not_connected' });
    expect(mcpSignInFact(mcpSignInGrantView(server, null, null))).toEqual({ state: 'not_connected' });
    expect(mcpSignInGrantView(server, null, false)).toEqual({ state: 'no_machine_online' });
    expect(mcpSignInGrantView(server, null, true)).toEqual({ state: 'not_connected' });
    expect(mcpSignInGrantView(server, grant, null, { configuration: configuration() })).toMatchObject({ state: 'connected' });
    expect(mcpSignInGrantView(server, grant, null, { unavailable: true })).toEqual({ state: 'did_not_finish' });
    expect(mcpSignInGrantView(server, { ...grant, status: 'needs_reauth' }, null)).toEqual({ state: 'expired', reason: 'expired' });
    expect(mcpSignInGrantView(server, grant, null)).toEqual({ state: 'starting' });
  });
  it('compares the full canonical resource rather than only the matching server id', () => {
    expect(mcpSignInGrantView(server, grant, true, { configuration: configuration('https://mcp.linear.app/other') }))
      .toEqual({ state: 'expired', reason: 'address_changed' });
    expect(mcpSignInGrantView(server, grant, true, { configuration: configuration('https://mcp.linear.app:443/mcp') }))
      .toMatchObject({ state: 'connected' });
  });

  it('projects unsatisfied challenge scopes and clears only after that access is granted', () => {
    const diagnostics = { configuration: configuration(undefined, ['read', 'write']) };
    const view = mcpSignInGrantView(server, grant, true, diagnostics);
    expect(view).toEqual({ state: 'needs_more_access', scope: 'write' });
    expect(mcpSignInFact(view)).toEqual({ state: 'needs_more_access' });
    expect(mcpSignInGrantView(server, { ...grant, scopes: ['read', 'write'] }, true, diagnostics)).toMatchObject({ state: 'connected' });
  });

  it('projects an exact revoke receipt, including after the grant disappears', () => {
    const revoked = { status: 'revoked', account: ref, remoteStatus: 'remoteUnsupported' } satisfies NonNullable<McpSignInGrantDiagnostics['revoked']>;
    expect(mcpSignInGrantView(server, grant, true, { revoked })).toEqual({ state: 'revoked' });
    expect(mcpSignInFact(mcpSignInGrantView(server, null, true, { revoked }))).toEqual({ state: 'revoked' });
    expect(mcpSignInGrantView(server, grant, true, { revoked: { ...revoked, account: { ...ref, accountId: 'other' } }, configuration: configuration() }))
      .toMatchObject({ state: 'connected' });
  });

  it('never promotes missing, unavailable, misbound or stale diagnostics to Connected', () => {
    expect(mcpSignInGrantView(server, grant, true)).toEqual({ state: 'starting' });
    expect(mcpSignInGrantView(server, grant, true, { unavailable: true })).toEqual({ state: 'did_not_finish' });
    const safe = configuration();
    expect(mcpSignInGrantView(server, grant, true, { configuration: { ...safe, target: { kind: 'account', account: { ...ref, accountId: 'other' }, modeId: 'oauth' } } }))
      .toEqual({ state: 'did_not_finish' });
    expect(mcpSignInGrantView(server, { ...grant, configurationRevision: 'new-revision' }, true, { configuration: safe }))
      .toEqual({ state: 'did_not_finish' });
  });

  it('uses credential health for expiry and keeps non-OAuth servers out of the sign-in flow', () => {
    expect(mcpSignInGrantView(server, { ...grant, status: 'needs_reauth' }, true, { configuration: configuration() }))
      .toEqual({ state: 'expired', reason: 'expired' });
    expect(mcpSignInGrantView({ ...server, remote: { ...server.remote!, auth: undefined } }, grant, true)).toBeNull();
  });
});
