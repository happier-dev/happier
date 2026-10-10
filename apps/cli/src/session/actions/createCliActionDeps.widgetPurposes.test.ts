import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets/widgetDefinitionV1';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionDeps } from './createCliActionDeps';

describe('Widget viewer purpose transport through the public CLI Action owner', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it.each(['ready', 'mode-mismatch'] as const)('admits %s purpose authority with the captured Action token and Home', async outcome => {
    const accountId = 'widget-viewer';
    const home = 'https://captured-widget-home.example.test';
    // Tokens are opaque HTTP boundary fixtures: the Action transport credential
    // is deliberately distinct from the stored Account credential.
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const actionToken = 'named-widget-action-transport-token';
    const consumer = { pluginId: 'acme.widgets', localId: 'repository-status' };
    const service = { pluginId: 'acme.accounts', localId: 'repository' };
    const selected = { service, accountId: 'selected-from-row' };
    const profile = AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{ ref: selected, status: 'connected',
      revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', authenticationModeId: 'api-key',
      configurationReady: true, configurationRevision: 'configuration-a' }] });
    const inputSchema = { type: 'object', properties: { connection: { type: 'object', properties: {
      service: { type: 'object', properties: { pluginId: { type: 'string' }, localId: { type: 'string' } },
        required: ['pluginId', 'localId'], additionalProperties: false }, accountId: { type: 'string' },
    }, required: ['service', 'accountId'], additionalProperties: false } }, required: ['connection'], additionalProperties: false };
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'repository-widget', name: 'Repository',
      provenance: { source: { kind: 'authored' } }, sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
      inputs: { fields: [{ path: 'connection', title: 'Connection', widget: 'select', required: true, connectedAccountOptions: true }] },
      inputSchema, connectedAccountPurposeBindings: [{ path: 'connection', consumer, purpose: 'repository.read' }],
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Status',
        data: { kind: 'resource', resource: consumer, inputSchema, outputSchema: { type: 'object',
          properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } },
        value: { path: ['count'], type: 'number' } } } } });
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, resourcesById: { resource: {
      pluginId: consumer.pluginId, id: consumer.localId, resourceKind: 'config', path: 'status.json',
      connectedAccountPurposes: [{ purpose: 'repository.read', serviceRefs: [service] }],
    } } });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({}), rawSettings: {} });
    const unexpectedAuthorization: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe(home);
      const headers = Object.entries(options?.headers ?? {}).filter(([name]) => name.toLowerCase() === 'authorization');
      if (headers.length !== 1 || headers[0]?.[1] !== `Bearer ${actionToken}`
        || options?.headers?.[AUTHORITY_CEILING_HEADER_V1] !== 'account_automation') {
        unexpectedAuthorization.push(parsed.pathname);
        return { status: 403, data: { error: 'forbidden' } };
      }
      if (parsed.pathname === '/v1/account/profile') return { status: 200, data: profile };
      if (parsed.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (parsed.pathname.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (parsed.pathname.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 4,
        content: outcome === 'ready' ? { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{
          purpose: { consumer, purpose: 'repository.read' }, target: { kind: 'account', account: selected },
        }] } } } : { t: 'encrypted', c: 'other-account-mode' } } };
      if (parsed.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      return { status: 404, data: { error: 'unsupported' } };
    });
    const deps = createCliActionDeps({ credentials, token: actionToken, sessionId: 'widget-test-session', mode: 'plain', ctx: null,
      serverId: 'captured-widget-home', serverHttpBaseUrl: home,
      machineActionDirectTargetTransport: { machineId: 'widget-machine', invoke: async () => ({ protocolVersion: 1, projection }) } });
    const result = await deps.widgetInputs!.resolve({
      ref: { surface: { serverId: 'captured-widget-home', accountId, owner: { kind: 'home' } }, instanceId: 'widget-copy' },
      instance: { v: 1, id: 'widget-copy', definition: { kind: 'inline', definition },
        bindings: { connection: { kind: 'viewer', purpose: 'repository.read' } } },
      groupBindings: {},
      context: { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } },
    });
    expect(result).toMatchObject(outcome === 'ready' ? { status: 'ready', input: { connection: selected } } : { status: 'unavailable' });
    expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject(outcome === 'ready'
      ? { status: 'ready', revision: 4 }
      : { status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(unexpectedAuthorization).toEqual([]);
  });
});
