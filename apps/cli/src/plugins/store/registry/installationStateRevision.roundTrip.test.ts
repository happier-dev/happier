import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { defineProtocolObject } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineAccessProviderSchemas } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolvePluginStorePathLayout } from '../pathLayout';
import {
  persistInstallationStateRevision,
  readInstallationStateRevision,
  type PluginInstallationStateRevision,
} from './generationStore';

it('round-trips current Access Provider role contracts through installation publication and cold reading', async () => {
  const config = defineProtocolObject({}, { policy: 'closed' });
  const roles = defineAccessProviderSchemas({ config });
  const membershipProgram = (role: 'join' | 'leave') => ({
    id: `network-${role}`, revision: '1', title: role,
    inputSchema: roles[`${role}Input`].jsonSchema,
    steps: [{ id: role, kind: 'command', executable: 'network-client', args: [role],
      check: { executable: 'network-client', args: ['status'], unsatisfiedExitCodes: [1] } }],
  });
  const approvedAuthorityManifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
    id: 'acme.network',
    contributes: {
      accessProviders: [{
        id: 'network', title: 'Network', icon: 'network', schemaVersion: 1,
        targets: ['machine'], capabilities: ['privateNetwork'], exposure: 'privateNetwork',
        configSchema: config.jsonSchema, inboundPorts: [], credentialPurposes: [],
        actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
        membership: { join: membershipProgram('join'), leave: membershipProgram('leave') },
      }],
      actions: (['inspect', 'join', 'leave'] as const).map(role => ({
        id: role, title: role, scopes: ['machine'], surfaces: ['plugin'], execution: { target: 'daemon' },
        dangerLevel: role === 'inspect' ? 'safe' : 'externalSideEffect',
        inputSchema: roles[`${role}Input`].jsonSchema, resultSchema: roles.result.jsonSchema,
      })),
    },
  }));
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-installation-role-roundtrip-'));
  try {
    const paths = resolvePluginStorePathLayout(happyHomeDir);
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1', schemaVersion: 1,
      revisionId: 'state-current-access-contracts', createdAtMs: 1,
      plugins: {
        'acme.network': {
          enabled: true, source: { distribution: { kind: 'localPath', canonicalPath: happyHomeDir } },
          updatePolicy: 'allowed', optionalAccess: [], approvedAuthorityManifest,
        },
      },
      rollbackRetention: [],
    };
    const reference = await persistInstallationStateRevision({ paths, state });
    await expect(readInstallationStateRevision({ paths, reference })).resolves.toEqual(state);
    await expect(persistInstallationStateRevision({ paths, state })).resolves.toEqual(reference);
  } finally {
    await rm(happyHomeDir, { recursive: true, force: true });
  }
});
