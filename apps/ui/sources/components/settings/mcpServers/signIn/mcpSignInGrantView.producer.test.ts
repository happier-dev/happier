import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedAccountRevokedResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { executeConnectedServiceConfigurationActionV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { mcpSignInGrantView, mcpSignInFact } from './mcpSignInGrantView';

const ref = { service: { pluginId: 'happier', localId: 'mcp-sign-in' }, accountId: 'linear' };
const server = McpServerCatalogEntryV1Schema.parse({ id: ref.accountId, name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {}, auth: { kind: 'oauth' } } });
const grant = QualifiedConnectedAccountProfileV4Schema.parse({ ref, status: 'connected', authenticationModeId: 'oauth', configurationReady: true,
  configurationRevision: 'configuration-1', kind: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', scopes: ['read'] });

async function configuration(resource: string, stepUpScopes: string[] = []) {
  // Real configuration Action producer, with only its daemon transport substituted. The safe response
  // is the host MCP runtime's account-scoped configuration (no token or secret values).
  const result = await executeConnectedServiceConfigurationActionV1({
    assertCurrent: () => {},
    mutatePurposeBindings: async () => { throw new Error('unexpected purpose mutation'); },
    resolveAgent: async () => { throw new Error('unexpected agent read'); },
    resetQuota: async () => { throw new Error('unexpected quota reset'); },
    request: async () => { throw new Error('unexpected HTTP'); },
    controlCommand: async () => ({ status: 'configuration', target: { kind: 'account', account: ref, modeId: 'oauth' },
      occurrenceId: 'host-1', sourceCustody: { kind: 'host' },
      mode: { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://cloud.happier.dev/oauth/mcp/callback', pkce: 'required', outcomeReconciliation: 'none' },
      configuration: { status: 'ready', revision: 'configuration-1', values: { serverId: server.id, resource, grantedScopes: grant.scopes, stepUpScopes }, configuredSecretFieldIds: [], missingFieldIds: [] },
    }),
  }, 'connectedServices.configuration.get', { machineId: 'm1', target: { kind: 'account', account: ref } });
  return CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].parse(result);
}

describe('the configuration Action producer to shared MCP grant/status projection', () => {
  it('refuses Connected when the current resource changed, while canonical equivalent addresses match', async () => {
    expect(mcpSignInGrantView(server, grant, true, { configuration: await configuration('https://other.example/mcp') })).toEqual({ state: 'expired', reason: 'address_changed' });
    expect(mcpSignInGrantView(server, grant, true, { configuration: await configuration('https://mcp.linear.app:443/mcp') })).toMatchObject({ state: 'connected' });
  });
  it('names a sign-in by its email or name, and by nothing when the provider only gave an opaque account id', async () => {
    const safe = await configuration(server.remote!.url);
    const identityOf = (providerIdentity: Record<string, string>) => {
      const view = mcpSignInGrantView(server, { ...grant, providerIdentity }, true, { configuration: safe });
      return view?.state === 'connected' ? view.identity : undefined;
    };
    expect(identityOf({ email: 'leeroy@acme.dev', accountId: '8d516553-3119-48fa-ab2b-b000cbd634fd' })).toBe('leeroy@acme.dev');
    expect(identityOf({ accountId: '8d516553-3119-48fa-ab2b-b000cbd634fd' })).toBeNull();
  });
  it('projects the daemon scope challenge as Grant access, and clears after the union grant lands', async () => {
    const safe = await configuration(server.remote!.url, ['write']);
    const view = mcpSignInGrantView(server, grant, true, { configuration: safe });
    expect(view).toEqual({ state: 'needs_more_access', scope: 'write' });
    expect(mcpSignInFact(view)).toEqual({ state: 'needs_more_access' });
    expect(mcpSignInGrantView(server, { ...grant, scopes: ['read', 'write'] }, true, { configuration: safe })).toMatchObject({ state: 'connected' });
  });
  it('consumes the real revoke Action receipt including its metadata-cleanup result', async () => {
    const result = await executeConnectedServiceConfigurationActionV1({
      assertCurrent: () => {},
      mutatePurposeBindings: async () => {},
      resolveAgent: async () => { throw new Error('unexpected agent read'); },
      resetQuota: async () => { throw new Error('unexpected quota reset'); },
      request: async () => { throw new Error('unexpected HTTP'); },
      controlCommand: async () => ConnectedAccountRevokedResponseV1Schema.parse({ status: 'revoked', account: ref, remoteStatus: 'remoteUnsupported' }),
    }, 'connectedServices.accounts.revoke', { machineId: 'm1', account: ref, cleanupGroupReferences: true,
      expectedCredentialRevision: grant.credentialRevision });
    const revoked = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].parse(result);
    expect(revoked).toMatchObject({ status: 'revoked', metadataCleanup: { status: 'cleanup-pending' } });
    if (revoked.status !== 'revoked') throw new Error('Expected an acknowledged revocation');
    expect(mcpSignInGrantView(server, grant, true, { revoked })).toEqual({ state: 'revoked' });
    expect(mcpSignInGrantView(server, grant, true, { revoked: { ...revoked, account: { ...ref, accountId: 'other' } } })).not.toEqual({ state: 'revoked' });
  });
});
