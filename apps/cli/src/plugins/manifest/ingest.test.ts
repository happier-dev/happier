import { describe, expect, it } from 'vitest';
import { defineProtocolObject, defineProtocolString, preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { rehydratePluginContributionPointSemanticsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

import { ingestCanonicalPluginManifest } from './ingest';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createContributionRegistrationHost, deriveContributionRegistrationRightsForManifest } from '@/plugins/runtime/api/registrationRightsHost';

const fixture = {
  schemaVersion: 2,
  id: 'com.acme.parity',
  version: '1.0.0',
  displayName: 'Parity',
  engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/plugin.js' },
  contributes: {
    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
  },
} as const;

describe('CLI canonical manifest ingestion', () => {
  it('walks a published point schema once across repeated registry admissions', () => {
    const launchInput = defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' });
    const published = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ contributes: {
      pluginContributionPoints: [{ id: 'detail', protocols: [{ id: 'detail', version: 1, operations: {},
        surfaces: { detail: { required: true, presentation: 'content', inputSchema: launchInput.jsonSchema } } }] }],
    } }));
    const declaration = published.contributes.pluginContributionPoints[0]!.protocols[0]!;
    const rawSchema = declaration.surfaces!.detail!.inputSchema;
    let schemaDescriptorReads = 0;
    declaration.surfaces!.detail!.inputSchema = new Proxy(rawSchema, {
      getOwnPropertyDescriptor(value, key) {
        if (key === '$schema') schemaDescriptorReads++;
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });
    const ingested = ingestCanonicalPluginManifest(published, {
      admission: 'build', manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource',
    });
    if (!ingested.ok) throw new Error('Expected a published manifest');
    const protocol = ingested.manifest.contributes.pluginContributionPoints[0]!.protocols[0]!;
    const inputSchema = protocol.surfaces!.detail!.inputSchema;
    for (let admission = 0; admission < 3; admission++) {
      const semantics = rehydratePluginContributionPointSemanticsV1(protocol);
      expect(semantics?.surfaces[0]?.inputSchema.safeParse({ id: 'entry' }).success).toBe(true);
      expect(semantics?.surfaces[0]?.inputSchema.safeParse({ id: 1 }).success).toBe(false);
      const { validate } = preparePluginJsonSchema(inputSchema);
      expect(validate({ id: 'entry' })).toBe(true);
      expect(validate({ id: 1 })).toBe(false);
    }
    expect(schemaDescriptorReads).toBe(1);
  });

  it('loads healthy declarations and reports skipped declarations', () => {
    const input = createPluginManifestV2Fixture({ contributes: { actions: [
      { id: 'healthy', title: 'Healthy', scopes: ['session'], surfaces: ['cli'],
        execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' },
      { id: 'future', title: 'Future', scopes: ['session'], surfaces: ['cli'],
        execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe', futureRestriction: true },
      { id: 'bad', title: 'Bad', dangerLevel: 'future' },
    ] } });
    const result = ingestCanonicalPluginManifest(input, { sourceProvenance: 'localSource', purpose: 'installedRead' });
    expect(result).toMatchObject({ ok: true, manifest: { contributes: { actions: [{ id: 'healthy' }] } },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'plugin_contribution_skipped' })]) });
    expect(ingestCanonicalPluginManifest(input, { sourceProvenance: 'localSource' }).ok).toBe(false);
  });

  it('activation refuses registration of a skipped declaration against admitted rights', async () => {
    const result = ingestCanonicalPluginManifest(createPluginManifestV2Fixture({ contributes: { actions: [
      { id: 'healthy', title: 'Healthy', scopes: ['session'], surfaces: ['cli'],
        execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' },
      { id: 'skipped', title: 'Skipped', dangerLevel: 'future' },
    ] } }), { sourceProvenance: 'localSource', purpose: 'installedRead' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const host = createContributionRegistrationHost({ pluginId: result.manifest.id, occurrenceId: 'test',
      rights: deriveContributionRegistrationRightsForManifest(result.manifest), isOccurrenceCurrent: () => true });
    try {
      host.api.actions.register('healthy', async () => ({ ok: true }));
      expect(() => host.api.actions.register('skipped', async () => ({ ok: true }))).toThrow();
      expect(() => host.commit()).toThrow();
      expect(host.diagnostics()).toMatchObject([{ code: 'plugin_activation_failed' }]);
    } finally { await host.dispose(); }
  });

  it.each(['localSource', 'registryCustodied'] as const)('refuses an incompatible host range for %s', (sourceProvenance) => {
    const result = ingestCanonicalPluginManifest(createPluginManifestV2Fixture({ engines: { happier: '>=999.0.0' } }),
      { sourceProvenance, purpose: 'installedRead' });
    expect(result).toMatchObject({ ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_engine_incompatible' })] });
  });
  it.each([
    { schema: { type: 'string', pattern: '[' }, code: 'PLUGIN_SETTINGS_SCHEMA_INVALID' },
    { schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, code: 'PLUGIN_SETTINGS_PROJECTION_INVALID' },
  ])('refuses an unservable Settings group at ingress ($code)', ({ schema, code }) => {
    const manifest = createPluginManifestV2Fixture({ id: 'acme.invalid-settings', contributes: {
      settings: [{ id: 'preferences', title: 'Preferences', scope: 'daemon', target: { kind: 'plugin' },
        fields: [{ id: 'value', title: 'Value', schema }] }],
    } });
    expect(ingestCanonicalPluginManifest(manifest, { sourceProvenance: 'localSource' })).toMatchObject({
      ok: false, diagnostics: [{ code, pluginId: 'acme.invalid-settings', contributionId: 'preferences', fieldId: 'value' }],
    });
  });
  it('normalizes installed UTF-8 bytes and bundled objects identically', () => {
    const installed = ingestCanonicalPluginManifest(Buffer.from(JSON.stringify(fixture), 'utf8'), { sourceProvenance: 'registryCustodied' });
    const bundled = ingestCanonicalPluginManifest(fixture, { sourceProvenance: 'registryCustodied' });

    expect(installed).toEqual(bundled);
    expect(installed).toEqual({ ok: true, manifest: expect.any(Object) });
  });

  it('returns identical coded diagnostics for malformed installed and bundled input', () => {
    const malformed = { ...fixture, unexpectedBehavior: true };
    const installed = ingestCanonicalPluginManifest(Buffer.from(JSON.stringify(malformed), 'utf8'), { sourceProvenance: 'registryCustodied' });
    const bundled = ingestCanonicalPluginManifest(malformed, { sourceProvenance: 'registryCustodied' });

    expect(installed).toEqual(bundled);
    expect(installed).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid' })],
    });
  });

  it('keeps author-only engine opt-out separate from namespace authority', () => {
    const bundledFixture = {
      ...fixture,
      id: 'happier.fixture.parity',
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    };

    expect(ingestCanonicalPluginManifest(bundledFixture, { sourceProvenance: 'registryCustodied' }).ok).toBe(false);
    expect(ingestCanonicalPluginManifest(bundledFixture, { sourceProvenance: 'localSource',
      manifestAuthority: 'bundled_first_party',
      purpose: 'authoring',
      enforceEngineCompatibility: false,
    })).toEqual({ ok: true, manifest: expect.any(Object) });
  });
});
