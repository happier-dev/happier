import { expect, it } from 'vitest';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';

it('returns a typed unsupported query result instead of using the management key as a database credential', async () => {
  let requests = 0;
  const http = createPluginHttpFixture({ async request() { requests += 1; throw new Error('Unexpected provider request'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const credentialRef = { service: { pluginId: 'happier.deploy.neon', localId: 'neon' }, accountId: 'connected' };
  const input = { ...DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    targetLinkId: 'data-link', expectedTargetLinkRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: credentialRef.service.pluginId, localId: 'query-read' }, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'br-main' }, providerEnvironment: { kind: 'custom', id: 'br-main' } }),
    sql: 'select 1', params: {} };
  try {
    expect(entry.manifest.contributes.actions?.find(action => action.id === 'query-read')?.surfaces).toContain('ui');
    expect(await kit.invokeAction('query-read', input, { surface: 'ui' })).toEqual({ ok: false, error: 'unsupported_action',
      diagnostic: { code: 'neon_read_only_database_credential_required' } });
    expect(requests).toBe(0);
  } finally { await kit.dispose(); }
});
