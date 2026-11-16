import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { preparePluginJsonSchema, createPluginJsonSchemaZodObjectAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '../../../../../packages/protocol/src/json/storedReadSchema.ts';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { PluginActionContributionV2Schema, normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { createActionInputForm } from '../../../../ui/sources/components/plugins/actions/actionInputForm';
import { compilePluginJsonSchema as compileSdkPluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { compactActionSchemas } from './actionSchemas.ts';
import { checkTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { renderCliBundledPluginManifestAssets } from './registry.ts';
import { serializeCanonicalPluginManifest } from '../../../src/plugins/manifest/serialize';
import type { PluginManifestJson } from './projectionFacts.ts';

const record = {
  type: 'object', additionalProperties: false,
  properties: { title: { type: 'string', description: 'The complete title supplied by the person for this record.' } },
  required: ['title'],
} satisfies PluginJsonSchemaV2;

function fixture(): PluginManifestJson {
  const parsed = ingestPluginManifestV2({
    schemaVersion: 2, id: 'happier.schema-fixture', version: '0.0.0', displayName: 'Schema fixture',
    contributes: { actions: [{
      id: 'records/inspect', title: 'Inspect', description: 'Inspect records',
      scopes: ['global'], surfaces: ['agent', 'mcp', 'cli'], dangerLevel: 'safe', execution: { target: 'daemon' },
      sessionTarget: { field: 'sessionId', cardinality: 'one' },
      inputHints: { fields: [{ path: 'title', title: 'Title', widget: 'text' }] },
      confirmation: { title: 'Inspect?', inputFields: [{ path: 'review.title', title: 'Review' }] },
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { sessionId: { type: 'string' }, title: record.properties.title, review: record,
          firstLabel: record.properties.title, secondLabel: record.properties.title,
          firstChoice: { type: 'string', enum: ['first', 'second'] }, secondChoice: { type: 'string', enum: ['first', 'second'] },
          firstDetails: { ...record, title: 'Details', description: 'The complete structured record supplied for review.' },
          secondDetails: { ...record, title: 'Details', description: 'The complete structured record supplied for review.' },
          first: record, second: record, third: record },
        required: ['sessionId', 'title', 'review', 'first', 'second', 'third'] },
      resultSchema: { type: 'object', additionalProperties: false,
        properties: { first: record, second: record, third: record }, required: ['first', 'second', 'third'] },
    }] },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.manifest;
}

describe('published Action schema compaction', () => {
  it.each([
    { name: 'GitHub', load: () => import('../../../../../packages/plugins/scm-github/src/manifest.ts') },
    { name: 'Sentry', load: () => import('../../../../../packages/plugins/sentry/src/manifest.ts') },
    { name: 'Linear', load: () => import('../../../../../packages/plugins/linear/src/manifest.ts') },
  ])('preserves the public source ABI through $name manifest publication', async ({ load }) => {
    const source = await load();
    const before = checkTriageSourceContributionV1(source.PLUGIN_MANIFEST);
    expect(before.ok, before.ok ? undefined : before.errors.join('\n')).toBe(true);
    const assets = renderCliBundledPluginManifestAssets({ pluginPackages: [{
      pluginId: source.PLUGIN_MANIFEST.id, pluginPackageId: 'source-fixture',
      packageName: '@happier-dev/plugins-source-fixture', packageVersion: '0.0.0',
      manifest: source.PLUGIN_MANIFEST,
    }] });
    const after = checkTriageSourceContributionV1(JSON.parse(assets[0]!.out));
    expect(after.ok, after.ok ? undefined : after.errors.join('\n')).toBe(true);
  });
  it('compacts and admits the final asset while preserving authored runtime agreement facts', () => {
    const manifest = fixture();
    const original = JSON.stringify(manifest);
    const assets = renderCliBundledPluginManifestAssets({ pluginPackages: [{
      pluginId: manifest.id, pluginPackageId: 'schema-fixture', packageName: '@happier-dev/plugins-schema-fixture',
      packageVersion: '0.0.0', manifest,
    }] });
    const parsed = ingestPluginManifestV2(assets[0]!.out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.actions[0]!.inputSchema!.properties!.first!.$ref).toBeDefined();
    // Authored order and the writer's canonical key order must project the
    // same declarations, including generated definition identities.
    const admitted = ingestPluginManifestV2(serializeCanonicalPluginManifest(manifest));
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    expect(compactActionSchemas(admitted.manifest)).toEqual(compactActionSchemas(manifest));
    expect(JSON.stringify(manifest)).toBe(original);
    expect(manifest.contributes.actions[0]!.inputSchema!.properties!.first!.type).toBe('object');
  });

  it.each([
    { name: 'provisioner', load: () => import('../../../../../packages/plugins/machine-cua/src/manifest.ts') },
    { name: 'Vercel deployment', load: () => import('../../../../../packages/plugins/deploy-vercel/src/manifest.ts') },
    { name: 'Cloudflare deployment', load: () => import('../../../../../packages/plugins/deploy-cloudflare/src/manifest.ts') },
    { name: 'Neon data target', load: () => import('../../../../../packages/plugins/deployment-neon/src/manifest.ts') },
    { name: 'Supabase data target', load: () => import('../../../../../packages/plugins/deployment-supabase/src/manifest.ts') },
    { name: 'Event Automation', load: () => import('../../../../../packages/plugins/sentry/src/manifest.ts') },
    { name: 'Health Event Automation', load: () => import('../../../../../packages/plugins/machine-services/src/manifest.ts') },
  ])('retains exact $name schema agreements during manifest publication', async ({ load }) => {
    const source = await load();
    const admitted = ingestPluginManifestV2(source.PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    const compacted = compactActionSchemas(admitted.manifest);
    const published = ingestPluginManifestV2(compacted);
    expect(published.ok, published.ok ? undefined : JSON.stringify(published.diagnostics)).toBe(true);
  });

  it('deduplicates actual schema nodes, preserves walked operands and validates through real consumers', async () => {
    const original = fixture();
    const compacted = compactActionSchemas(original);
    const action = compacted.contributes?.actions?.[0];
    const input = action?.inputSchema;
    const result = action?.resultSchema;
    expect(input?.properties?.first?.$ref).toMatch(/^#\/definitions\//u);
    expect(input?.properties?.second).toEqual(input?.properties?.first);
    expect(input?.properties?.sessionId).toEqual({ type: 'string' });
    expect(input?.properties?.title).toEqual(record.properties.title);
    expect(input?.properties?.review).toEqual(record);
    expect(input?.properties?.$ref).toBeUndefined();
    expect(input?.definitions?.$ref).toBeUndefined();
    expect(ingestPluginManifestV2(compacted).ok).toBe(true);
    expect(compactActionSchemas(compacted)).toEqual(compacted);
    expect(original).toEqual(fixture());
    if (!result) throw new Error('Missing result schema');
    const value = { first: { title: 'One' }, second: { title: 'Two' }, third: { title: 'Three' } };
    const prepared = preparePluginJsonSchema(result);
    expect(prepared.validate(value)).toBe(true);
    expect(prepared.validate({ ...value, second: { title: 42 } })).toBe(false);
    const sdkValidate = compileSdkPluginJsonSchema(result);
    expect(sdkValidate(value)).toBe(true);
    expect(sdkValidate({ ...value, second: { title: 42 } })).toBe(false);
    const adapter = createPluginJsonSchemaZodObjectAdapter(result);
    expect(adapter.safeParse(value).success).toBe(true);
    const stored = createStoredReadSchema(adapter);
    expect(stored.safeParse({ ...value, unknown: 'discard', first: { title: 'One', unknown: 'discard' } })).toMatchObject({ success: true, data: value });
    if (!input || !action?.inputHints) throw new Error('Missing input form declaration');
    const inputHints = normalizePluginActionInputHintsV2(action.inputHints, input);
    if (!inputHints) throw new Error('Missing normalized form declaration');
    const originalAction = original.contributes.actions[0]!;
    expect(inputHints).toEqual(normalizePluginActionInputHintsV2(originalAction.inputHints, originalAction.inputSchema));
    const form = createActionInputForm({
      presentation: { title: 'Inspect', description: null, inputHints },
      initialInput: { ...value, sessionId: 'session', title: 'Title', review: { title: 'Review' } },
      submit: async candidate => ({ ok: preparePluginJsonSchema(input).validate(candidate) }),
    });
    expect(form.getFields().find(field => field.path === 'title')).toMatchObject({ widget: 'text', visible: true });
    expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } });
    form.retire();
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(original).length);
  });

  it('keeps qualified Account and native-service operands inline across input union arms', () => {
    const original = fixture();
    const action = original.contributes.actions![0]!;
    const service = QualifiedConnectedAccountRefJsonSchema.properties!.service!;
    const common = { first: record, second: record, third: record };
    const inputs = [
      { type: 'object' as const, additionalProperties: false,
        properties: { ...common, account: QualifiedConnectedAccountRefJsonSchema }, required: ['account'] },
      { type: 'object' as const, additionalProperties: false,
        properties: { ...common, service }, required: ['service'] },
    ];
    const manifest = { ...original, contributes: { actions: [{ ...action,
      sessionTarget: undefined, inputHints: undefined, confirmation: undefined,
      inputSchema: { anyOf: [inputs[0]!, inputs[0]!, inputs[1]!] },
      connectedAccountPurposeBindings: [{ path: 'account', nativeServicePath: 'service', purpose: 'account-use' }],
    }] } };
    expect(PluginActionContributionV2Schema.safeParse(manifest.contributes.actions[0]).success).toBe(true);
    const compacted = compactActionSchemas(manifest);
    expect(PluginActionContributionV2Schema.safeParse(compacted.contributes.actions![0]).success).toBe(true);
    const arms = compacted.contributes.actions![0]!.inputSchema!.anyOf!;
    for (const arm of arms) {
      expect(arm.$ref).toBeUndefined();
      expect(arm.properties?.first?.$ref).toBeDefined();
    }
    expect(arms[0]!.properties?.account).toEqual(QualifiedConnectedAccountRefJsonSchema);
    expect(arms[2]!.properties?.service).toEqual(service);
  });

  it('keeps inferred form fields reachable across repeated object union arms', () => {
    const original = fixture();
    const action = original.contributes.actions[0]!;
    const arm = { type: 'object' as const, additionalProperties: false,
      properties: { first: record, second: record, third: record }, required: ['first', 'second', 'third'] };
    const inputSchema = { anyOf: [arm, arm] };
    const source = { ...original, contributes: { actions: [{ ...action, inputSchema,
      inputHints: undefined, sessionTarget: undefined, confirmation: undefined }] } };
    const compacted = compactActionSchemas(source);
    expect(normalizePluginActionInputHintsV2(undefined, compacted.contributes.actions[0]!.inputSchema))
      .toEqual(normalizePluginActionInputHintsV2(undefined, inputSchema));
  });

  it('preserves existing pointer targets, definition names and schema-shaped literal values', () => {
    const original = fixture();
    const action = original.contributes.actions![0]!;
    const resultSchema = { ...action.resultSchema,
      definitions: { schema0: record },
      properties: { ...action.resultSchema!.properties,
        byPointer: { $ref: '#/properties/first/properties/title' },
        byDefinition: { $ref: '#/definitions/schema0' },
        literal: { const: { properties: record, definitions: record, first: record, second: record } },
      },
    };
    const compacted = compactActionSchemas({ ...original, contributes: { actions: [{ ...action, resultSchema }] } });
    const result = compacted.contributes.actions![0]!.resultSchema!;
    expect(result.properties?.first?.properties?.title).toEqual(record.properties.title);
    expect(result.definitions?.schema0).toEqual(record);
    expect(result.properties?.literal).toEqual(resultSchema.properties.literal);
    expect(preparePluginJsonSchema(result).validate({ first: { title: 'A' }, second: { title: 'B' }, third: { title: 'C' }, byPointer: 'Title' })).toBe(true);
    expect(compactActionSchemas(compacted)).toEqual(compacted);
  });
});
