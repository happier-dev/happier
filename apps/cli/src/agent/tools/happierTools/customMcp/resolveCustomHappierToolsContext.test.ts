import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema, formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveCustomHappierToolsContext } from './resolveCustomHappierToolsContext';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('refuses custom-tool material revoked at the captured Home instead of using a stale SavedSecret resource', async () => {
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'custom-mcp-account' })).toString('base64url')}.signature`, encryption: null };
  const resourceId = 'revoked-custom-mcp-resource';
  const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
  const resource = { resourceId, ownerAccountId: 'custom-mcp-account', displayName: 'Custom key', kind: 'apiKey' as const,
    encryptionMode: 'plain' as const, revision: 4, materialStatus: 'ready' as const,
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
      v: 1, name: 'Custom key', kind: 'apiKey', value: 'stale-private-material',
    } }),
  };
  const serverHttpBaseUrl = 'https://custom-mcp-home.test';
  const snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl,
    () => resolveAccountSettingsScopeKey(credentials)),
    settings: accountSettingsParse({ mcpServersStrictMode: true }), rawSettings: { mcpServersStrictMode: true },
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready', savedSecretResources: [resource],
    mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog: McpServerCatalogV1Schema.parse({
      v: 1, servers: [{ id: 'custom', name: 'custom', transport: 'stdio', stdio: { command: 'echo', args: [] },
        env: { API_KEY: { t: 'savedSecret', secretId: ref } }, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding', serverId: 'custom', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
    }) },
  };
  const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl,
    () => createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl, snapshot, isCurrent: async () => true }));
  // Only Home HTTP boundaries are replaced; admission and materialization stay real.
  const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    if (String(input) !== 'https://custom-mcp-home.test/v1/account/saved-secrets/resources/materials') throw new Error('Unexpected Home material request');
    return { status: 200, data: { resources: [] } };
  });
  const input = { credentials, accountSettingsSnapshot: snapshot,
    operationContext, machineId: 'machine', directory: '/workspace', processEnv: {} };
  await expect(resolveCustomHappierToolsContext(input)).rejects.toMatchObject({ reason: 'reference_forbidden', reference: ref });
});
