import { describe, expect, it } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PluginManifestV2Schema, PLUGIN_CONTRIBUTION_CATALOG_V2, derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';
import { definePlugin } from './definePlugin.js';
import { parsePluginManifest } from './manifest.js';
import { defineProtocolObject, defineProtocolString } from './protocol/protocolFacade.js';

// Runtime import keeps example source outside the SDK declaration program.
// Resolve the source graph during collection, before the Action's test budget.
const examplePath = fileURLToPath(new URL('../examples/public-authoring/index.ts', import.meta.url));
const { backupDestinationAuthoring: publicAuthorExample } = await import(pathToFileURL(examplePath).href);
const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');

const pluginId = 'acme.backups';
const configSchema = { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'], additionalProperties: false } as const;
const destination = {
  id: 'disk', title: 'Recovery disk', configSchema,
  credentialRoles: [{ role: 'repositoryPassword' }], resticTransport: 'local', locality: 'local',
  actions: {
    test: { pluginId, localId: 'destination/test' },
    open: { pluginId, localId: 'destination/open' },
  },
} as const;
const actions = ['destination/test', 'destination/open'].map(id => ({
  id, title: id, execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'],
  dangerLevel: id.endsWith('/test') ? 'writesRemote' : 'safe',
  inputSchema: configSchema, resultSchema: configSchema,
}));
const manifest = { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Backups', runtime: { apiVersion: 1 },
  contributes: { backupDestinations: [destination], actions } };

describe('public backup destination declarations', () => {
  it('binds the native repository test without requiring a competing contributed Action', () => {
    const test = { kind: 'hostAction', actionId: 'deployments.backups.test' };
    const parsed = parsePluginManifest({ ...manifest, contributes: { ...manifest.contributes,
      backupDestinations: [{ ...destination, actions: { ...destination.actions, test } }],
      actions: actions.filter(action => action.id !== 'destination/test'),
    } });
    expect(parsed).toMatchObject({ ok: true, manifest: { contributes: {
      backupDestinations: [{ actions: { test } }],
    } } });
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'backupDestinations');
    expect(family?.extractReferences({ ...destination, actions: { ...destination.actions, test } })).toEqual([
      { targetFamily: 'actions', reference: destination.actions.open, path: ['actions', 'open'], allowQualifiedSamePlugin: true },
    ]);
  });
  it('normalizes an external qualified descriptor without a destination runtime registration', () => {
    const parsed = parsePluginManifest(manifest);
    expect(parsed).toMatchObject({ ok: true, manifest: { contributes: { backupDestinations: [destination] } } });
    expect(derivePluginDaemonContributionRegistrationRights(manifest.contributes)).toEqual(actions.map(action => ({
      family: 'actions', localId: action.id, target: { realm: 'daemon' },
    })));
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'backupDestinations');
    expect(family?.extractReferences(destination)).toEqual([
      { targetFamily: 'actions', reference: destination.actions.test, path: ['actions', 'test'], allowQualifiedSamePlugin: true },
      { targetFamily: 'actions', reference: destination.actions.open, path: ['actions', 'open'], allowQualifiedSamePlugin: true },
    ]);
    expect(family?.projectJsonSchema()).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('refuses unknown transport authority, open config objects and unqualified Action refs', () => {
    for (const invalid of [
      { ...destination, cleanup: destination.actions.test },
      { ...destination, resticTransport: 'rclone' },
      { ...destination, configSchema: { ...configSchema, additionalProperties: true } },
      { ...destination, configSchema: { ...configSchema, properties: { nested: { type: 'object' } } } },
      { ...destination, actions: { ...destination.actions, open: 'destination/open' } },
      { ...destination, credentialRoles: [{ role: 'repositoryPassword' }, { role: 'customToken' }] },
      { ...destination, credentialRoles: [{ role: 'repositoryPassword' }, { role: 'repositoryPassword', optional: true }] },
      { ...destination, credentialRoles: [{ role: 'repositoryPassword', optional: 'yes' }] },
      { ...destination, locality: 'offSite' },
    ]) expect(PluginManifestV2Schema.safeParse({ ...manifest, contributes: { ...manifest.contributes, backupDestinations: [invalid] } }).success).toBe(false);
    expect(parsePluginManifest({ ...manifest, contributes: { ...manifest.contributes, actions: actions.slice(0, 1) } }).ok).toBe(false);
    expect(PluginManifestV2Schema.safeParse({ ...manifest, contributes: { ...manifest.contributes,
      backupDestinations: [{ ...destination, locality: 'offHost' }] } }).success).toBe(false);
  });

  it('can express proved off-host storage without inferring it from a transport', () => {
    for (const locality of ['offHost', 'unknown'] as const) {
      expect(parsePluginManifest({ ...manifest, contributes: { ...manifest.contributes,
        backupDestinations: [{ ...destination, resticTransport: 's3', locality,
          credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' }] }] } }).ok).toBe(true);
    }
  });

  it('authors descriptors through the existing definePlugin descriptor adapter', () => {
    const { id: _id, ...declaration } = destination;
    const config = defineProtocolObject({ directory: defineProtocolString() }, { policy: 'closed' });
    const plugin = definePlugin({ id: pluginId, version: '1.0.0',
      backupDestinations: { disk: declaration },
      actions: {
        'destination/test': { title: 'Test destination', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'writesRemote',
          inputSchema: config, resultSchema: config, run: () => { throw new Error('Descriptor-only fixture has no transport implementation'); } },
        'destination/open': { title: 'Open destination', execution: { target: 'daemon' }, surfaces: ['plugin'], dangerLevel: 'safe',
          inputSchema: config, resultSchema: config, run: () => { throw new Error('Descriptor-only fixture has no transport implementation'); } },
      },
    });
    expect(parsePluginManifest(plugin.manifest)).toMatchObject({ ok: true, manifest: { contributes: { backupDestinations: [destination] } } });
  });

  it('binds the maintained public author example without claiming native transport availability', async () => {
    const example = publicAuthorExample;
    const parsed = parsePluginManifest(example.manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Public destination example manifest is invalid');
    const [declared] = parsed.manifest.contributes.backupDestinations;
    if (!declared) throw new Error('Public destination example has no descriptor');
    expect(declared).toMatchObject({
      resticTransport: 's3', locality: 'unknown',
      credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' }],
    });
    const fixture = await createPluginTestkit({ manifest: example.manifest, module: example });
    try {
      const input = { endpoint: 'https://storage.example.invalid', bucket: 'recovery', prefix: 'environment' };
      for (const reference of Object.values(declared.actions)) {
        if ('kind' in reference) throw new Error('The external author fixture declares its own probe');
        expect(reference.pluginId).toBe(example.manifest.id);
        expect(await fixture.invokeAction(reference.localId, input)).toEqual({
          kind: 'unavailable', reason: 'example_has_no_native_transport',
        });
      }
      await expect(fixture.invokeAction(declared.actions.open.localId, {
        ...input, secretAccessKey: 'must-not-be-accepted-as-config',
      })).rejects.toThrow();
    } finally { await fixture.dispose(); }
  });
});
