import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PLUGIN } from './manifest.js';
import { ACCOUNT_SERVICE, DEPENDENCY_ID } from './machine/schemas.js';
import { CODER_PORTABLE_ACCOUNT_RUNTIME } from './machine/connection.js';
import { coderWorkspaceName } from './machine/nativeClient.js';
import type { ConnectedAccountPortableAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
const cleanup: Array<() => Promise<void>> = [];
const resource = { workspaceId: 'workspace', ownerId: 'user-a', ownerName: 'alice', workspaceName: coderWorkspaceName('managed-test'),
  organizationId: 'org', templateId: 'template', agentName: 'main', managedId: 'managed-test' };
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function deployment(status = 200) {
  const paths: string[] = [];
  const server = createServer((req, res) => { const path = new URL(req.url!, 'http://fixture').pathname; paths.push(path); res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(path.endsWith('/users/me') ? { id: 'user-a', username: 'alice' }
      : path === '/api/v2/workspaces/workspace' ? { id: resource.workspaceId, owner_id: resource.ownerId, owner_name: resource.ownerName,
        name: resource.workspaceName, organization_id: resource.organizationId, template_id: resource.templateId,
        latest_build: { id: 'build', workspace_id: resource.workspaceId, template_version_id: 'version', transition: 'start', status: 'running',
          job: { status: 'succeeded' }, resources: [{ agents: [{ id: 'main', name: 'main', status: 'connected' }] }] } }
      : path.endsWith('/templates') ? [{ id: 'template', name: 'Docker', organization_id: 'org', active_version_id: 'version' }]
      : path.endsWith('/rich-parameters') ? [{ name: 'project', required: true, default_value: '' }]
      : { id: 'version', organization_id: 'org', template_id: 'template' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${address.port}`;
  const http = { request: async (request: { url: string; method?: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array; redirect?: RequestRedirect }, options?: { signal?: AbortSignal }) => {
    const response = await fetch(request.url, { ...request, signal: options?.signal });
    return { status: response.status, finalUrl: response.url, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
  } };
  return { endpoint, http, paths };
}
describe('Coder public authoring entry and portable authentication', () => {
  it('offers first-administrator setup through native Connected services with a private password field', () => {
    const service = PLUGIN.manifest.contributes.connectedAccountDescriptors?.find(entry => entry.id === ACCOUNT_SERVICE.localId);
    const mode = service?.authentication.modes.find(entry => entry.id === 'first-admin');
    expect(mode).toMatchObject({ kind: 'manual', browserReachability: 'unreachable',
      fields: [{ id: 'username' }, { id: 'email' }, { id: 'password', secret: true }],
      configuration: { fields: [{ id: 'endpoint', semantic: 'connectedAccountBase', secret: false }] },
    });
    expect(mode).not.toHaveProperty('accountDirectSave');
    expect(mode).not.toHaveProperty('directExport');
    expect(mode).not.toHaveProperty('credentialFieldKeys');
  });
  it('consumes the existing Coder recipe and observed Tailscale HTTPS URL before first-administrator sign-in', () => {
    const mode = PLUGIN.manifest.contributes.connectedAccountDescriptors?.find(entry => entry.id === ACCOUNT_SERVICE.localId)
      ?.authentication.modes.find(entry => entry.id === 'first-admin');
    expect(mode).toMatchObject({ machineSetup: {
      recipe: { pluginId: 'happier.machine.recipes', recipeId: 'coder', revision: '1' },
      inputPrefill: [{ path: 'accessUrl', source: { kind: 'privateNetworkHttps', provider: { kind: 'builtin', id: 'tailscale' } } }],
      afterApply: { modeId: 'first-admin', configurationFromInputs: { endpoint: 'accessUrl' } },
    } });
    expect(PLUGIN.manifest.contributes.connectedAccountDescriptors?.find(entry => entry.id === ACCOUNT_SERVICE.localId)
      ?.authentication.modes.find(entry => entry.id === 'token')).not.toHaveProperty('machineSetup');
  });
  it.each(['missing', 'ready'] as const)('uses the host dependency %s result and preserves actionable CLI remediation', async state => {
    const h = await deployment();
    // The managed-dependency service is the genuine host boundary for a plugin;
    // the public testkit runs declaration admission, Action projection and HTTP.
    const services = { http: h.http, connectedAccounts: {
      getBinding: async () => ({ account: { service: ACCOUNT_SERVICE, accountId: 'test-account' } }),
      materialize: async () => ({ kind: 'environment', env: { CODER_URL: h.endpoint, CODER_SESSION_TOKEN: 'private-token' } }),
    }, managedServices: { dependencies: { status: async (id: string) => {
      expect(id).toBe(DEPENDENCY_ID);
      return state === 'missing' ? { state, id, supported: true } : { state, id, version: '2.39.0', sourceId: 'system', executable: { kind: 'managedDependency', id } };
    } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services });
    cleanup.push(() => kit.dispose());
    const result = kit.invokeAction('check', {}, { surface: 'plugin' });
    if (state === 'ready') {
      expect(MachineProvisionerCheckResultV1Schema.parse(await result)).toEqual({ available: true });
    } else {
      const check = MachineProvisionerCheckResultV1Schema.parse(await result);
      expect(check).toMatchObject({ available: false, code: 'coder_cli_unavailable', prerequisites: [{
        requirement: { kind: 'managedDependency', id: { pluginId: PLUGIN.manifest.id, localId: DEPENDENCY_ID } },
        status: 'unavailable', repairAction: { action: { pluginId: PLUGIN.manifest.id, localId: 'cli-install-docs' }, input: {} },
      }] });
      expect(check.prerequisites?.[0]?.reason).toContain(`${h.endpoint}/install.sh`);
      expect(check.prerequisites?.[0]?.reason).toContain('https://coder.com/docs/install/cli');
      expect(PLUGIN.manifest.contributes.actions?.find(action => action.id === 'cli-install-docs')).toMatchObject({
        execution: { target: 'client', client: { artifactId: 'cli-install', exportName: 'activate' } }, dangerLevel: 'safe' });
      const error: unknown = await kit.invokeAction('bootstrap', { resource }, { surface: 'plugin' }).catch(error => error);
      expect(isPluginError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'coder_cli_unavailable', remediation: { kind: 'openUrl', url: 'https://coder.com/docs/install/cli' },
        data: { code: 'coder_cli_unavailable', remediation: { kind: 'openUrl', url: 'https://coder.com/docs/install/cli' } } });
      if (!isPluginError(error)) throw new Error('Missing typed refusal');
      expect(error.message).toContain(`${h.endpoint}/install.sh`);
      expect(error.message).toContain('https://coder.com/docs/install/cli');
      expect(error.message).toContain('matching your Coder deployment');
      expect(JSON.stringify(error)).not.toContain('private-token');
    }
    expect(h.paths).toEqual(state === 'ready' ? ['/api/v2/users/me'] : ['/api/v2/users/me', '/api/v2/users/me', '/api/v2/workspaces/workspace']);
  });
  it('runs the existing options action through the loaded declaration and selected account', async () => {
    const h = await deployment(); let materializations = 0;
    // Only the host service boundary is supplied; declaration parsing, action
    // registration, schemas, options and HTTP decoding remain real.
    const services = { http: h.http, connectedAccounts: {
      getBinding: async () => ({ account: { service: ACCOUNT_SERVICE, accountId: 'test-account' } }),
      materialize: async () => { materializations++; return { kind: 'environment', env: { CODER_URL: h.endpoint, CODER_SESSION_TOKEN: 'private-token' } }; },
    } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services });
    cleanup.push(() => kit.dispose());
    const result = await kit.invokeAction('options', { organizationId: 'org', templateId: 'template', agentName: 'main', parameterValues: [{ name: 'project', value: 'explicit' }] }, { surface: 'plugin' });
    expect(result).toMatchObject({ base: { launch: { templateVersionId: 'version', agentName: 'main', parameterValues: [{ name: 'project', value: 'explicit' }] } } });
    expect(materializations).toBe(1);
    expect(h.paths).toHaveLength(3);
  });
  it.each(['root', 'nested'] as const)('portable token completion validates local configuration and stages without browser HTTP (%s)', async endpointKind => {
    const h = await deployment(); const stored: string[] = []; let browserRequests = 0;
    // A browser HttpService transport failure is the genuine CORS boundary.
    // Account connection must not depend on reaching a private deployment here.
    const context = { signal: new AbortController().signal,
      configuration: { values: { endpoint: h.endpoint + (endpointKind === 'nested' ? '/workspace' : '') } },
      services: { http: { request: async () => { browserRequests++; throw new TypeError('Failed to fetch'); } } },
      attempt: { kind: 'connect' }, attemptCredentials: { set: async (_key: string, value: string) => { stored.push(value); } },
    } as unknown as ConnectedAccountPortableAuthenticationContext;
    const mode = CODER_PORTABLE_ACCOUNT_RUNTIME.authentication.modes.token;
    if (!mode || mode.kind !== 'manual') throw new Error('Missing token authentication');
    const result = await mode.complete({ fields: { token: 'private-token' } }, context);
    expect(result.status).toBe(endpointKind === 'root' ? 'connected' : 'rejected');
    expect(stored).toEqual(endpointKind === 'root' ? ['private-token'] : []);
    expect(browserRequests).toBe(0);
    expect(h.paths).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
});
