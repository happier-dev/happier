import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { defineProtocolObject } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineAccessProviderSchemas } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { readInstalledPluginCatalogSnapshot } from '@/plugins/projection/catalog/installed';
import { readPluginRegistryCommitRecord } from './commitRecord';
import { seedCurrentLocalPathPluginFixture } from './currentState.testkit';
import { resolvePluginStorePathLayout } from '../pathLayout';
import {
  persistInstallationStateRevision,
  readInstallationStateRevision,
  readCurrentCommittedPluginGenerations,
  type PluginInstallationStateRevision,
} from './generationStore';

function currentAccessManifest() {
  const config = defineProtocolObject({}, { policy: 'closed' });
  const roles = defineAccessProviderSchemas({ config });
  const membershipProgram = (role: 'join' | 'leave') => ({
    id: `network-${role}`, revision: '1', title: role,
    inputSchema: roles[`${role}Input`].jsonSchema,
    steps: [{ id: role, kind: 'command', executable: 'network-client', args: [role],
      check: { executable: 'network-client', args: ['status'], unsatisfiedExitCodes: [1] } }],
  });
  return PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
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
}

// The incident's exact drift: Saved Secret selections gained these schema facts.
function retireSavedSecretRoleFacts(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(retireSavedSecretRoleFacts);
    return;
  }
  const object = value as Record<string, unknown>;
  if (object.pattern === '^happier:shared-secret:v1:.*') {
    delete object.pattern;
    delete object.minLength;
    delete object.description;
  }
  Object.values(object).forEach(retireSavedSecretRoleFacts);
}

it('round-trips current Access Provider role contracts through installation publication and cold reading', async () => {
  const approvedAuthorityManifest = currentAccessManifest();
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

it('isolates one stale approved role contract while healthy installed plugins keep serving across publication', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-installation-approval-isolation-'));
  try {
    const staleId = 'acme.network';
    const healthyId = 'acme.healthy';
    for (const manifest of [currentAccessManifest(), PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: healthyId }))]) {
      const root = join(happyHomeDir, manifest.id);
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await writeFile(join(root, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
      await writeFile(join(root, 'daemon.mjs'), 'export function activate() {}');
      await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot: root, pluginId: manifest.id,
        manifestVersion: manifest.version, devWatch: true });
    }
    const paths = resolvePluginStorePathLayout(happyHomeDir);
    const commit = await readPluginRegistryCommitRecord(paths);
    if (!commit) throw new Error('Fixture did not publish its installation state');
    const path = join(paths.stateRevisionsDir, commit.installationState.revisionId, 'plugin-installations.v1.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as PluginInstallationStateRevision;
    retireSavedSecretRoleFacts(stored.plugins[staleId]!.approvedAuthorityManifest);
    expect(PluginManifestV2Schema.safeParse(stored.plugins[staleId]!.approvedAuthorityManifest).success).toBe(false);
    await expect(persistInstallationStateRevision({ paths, state: { ...stored, revisionId: 'state-rejected-stale-approval' } })).rejects.toThrow();
    const bytes = JSON.stringify(stored);
    await writeFile(path, bytes);

    const snapshot = await readInstalledPluginCatalogSnapshot({ happyHomeDir });
    expect(snapshot.entries.find(entry => entry.pluginId === staleId)).toMatchObject({
      compatibility: { status: 'load_error' },
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'plugin_trust_approval_required', details: { reason: 'needs_reapproval' },
      })]),
    });
    expect(snapshot.entries.find(entry => entry.pluginId === healthyId)?.manifest?.id).toBe(healthyId);
    expect((await loadInstalledPlugins({ happyHomeDir })).loadedPlugins.map(plugin => plugin.pluginId)).toEqual([healthyId]);
    const generations = await readCurrentCommittedPluginGenerations(paths, { isolateInvalidInstalledGenerations: true });
    expect([...generations!.generations.keys()]).toEqual([healthyId]);
    expect(await readFile(path, 'utf8')).toBe(bytes);

    const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir, runtimeOptions: { pluginIds: [healthyId] } });
    try {
      expect(runtime.controller.getState().lastResult).toMatchObject({ ok: true, registryStatus: 'active' });
      expect(runtime.registry.pluginDiagnosticsByPluginId[staleId]).toContainEqual(expect.objectContaining({
        code: 'plugin_trust_approval_required', details: { reason: 'needs_reapproval' },
      }));
      expect(runtime.registry.activatedPluginIds.has(healthyId)).toBe(true);
      // Gemini's declared static catalog needs no native executable or tenant.
      expect(runtime.registry.contributes.agentDefinitionsById.has('gemini')).toBe(true);
      const models = await probeAgentModelsBestEffort({ agentId: 'gemini', cwd: happyHomeDir,
        registrySnapshot: runtime.registry.contributes });
      expect(models.availableModels.length).toBeGreaterThan(0);
      expect(models.source).toBe('static');
    } finally {
      await runtime.dispose();
    }

    const projected = await readInstallationStateRevision({ paths, reference: commit.installationState });
    const reference = await persistInstallationStateRevision({ paths, state: { ...projected, revisionId: 'state-after-isolation' } });
    const next = await readInstallationStateRevision({ paths, reference });
    expect(next.plugins[healthyId]).toEqual(projected.plugins[healthyId]);
    expect(next.plugins[staleId]!.approvedAuthorityManifest).toBeUndefined();
    expect(next.runtimeCatalog!.plugins[staleId]?.install.trust).toBeUndefined();
    expect(next.runtimeCatalog!.plugins[staleId]?.compatibility.diagnostics).toContainEqual(expect.objectContaining({
      code: 'plugin_trust_approval_required', details: { reason: 'needs_reapproval' },
    }));
  } finally {
    await rm(happyHomeDir, { recursive: true, force: true });
  }
});

it('withdraws stale rollback approval without withdrawing the current approved installation', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-retained-approval-isolation-'));
  try {
    const paths = resolvePluginStorePathLayout(happyHomeDir);
    const approvedAuthorityManifest = currentAccessManifest();
    const distribution = { kind: 'localPath' as const, canonicalPath: happyHomeDir };
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1', schemaVersion: 1,
      revisionId: 'state-retained-approval', createdAtMs: 1,
      plugins: { [approvedAuthorityManifest.id]: { enabled: true, source: { distribution },
        updatePolicy: 'allowed', optionalAccess: [], approvedAuthorityManifest } },
      rollbackRetention: [{ pluginId: approvedAuthorityManifest.id, immutableGenerationId: 'generation-prior',
        retainedAtMs: 1, byteAvailability: 'available', pluginVersion: '1.0.0', distribution,
        approvedAuthorityManifest }],
    };
    const reference = await persistInstallationStateRevision({ paths, state });
    const path = join(paths.stateRevisionsDir, reference.revisionId, 'plugin-installations.v1.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as PluginInstallationStateRevision;
    retireSavedSecretRoleFacts(stored.rollbackRetention[0]!.approvedAuthorityManifest);
    await writeFile(path, JSON.stringify(stored));
    const read = await readInstallationStateRevision({ paths, reference });
    expect(read.plugins).toEqual(state.plugins);
    expect(read.rollbackRetention[0]).toMatchObject({ byteAvailability: 'sourceIneligible' });
    expect(read.rollbackRetention[0]!.approvedAuthorityManifest).toBeUndefined();

    await writeFile(path, JSON.stringify({ ...stored, revisionId: 'another-revision' }));
    await expect(readInstallationStateRevision({ paths, reference })).rejects.toThrow('Invalid installation state revision');
    await writeFile(path, '{');
    await expect(readInstallationStateRevision({ paths, reference })).rejects.toThrow('Invalid installation state revision');
  } finally {
    await rm(happyHomeDir, { recursive: true, force: true });
  }
});
