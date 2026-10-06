import { describe, expect, it } from 'vitest';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { collectManifestContributionIntrospectionCandidates, projectManifestContributionIntrospection } from './manifest';

describe('manifest contribution introspection', () => {
  it('collects admitted metadata once per manifest identity and source while projecting fresh generations', () => {
    const manifest = normalizePluginManifestV2({
      schemaVersion: 2, id: 'acme.retained', version: '1.0.0', displayName: 'Retained',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: {
        actions: [{
          id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'],
          execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe',
        }],
        voiceProviders: [{
          id: 'speech', title: 'Speech', kind: 'speech', roles: ['dictation_stt'],
          platforms: ['web'],
          settings: {
            schemaVersion: 2,
            fields: [{
              id: 'model', title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'stt', presentation: { control: 'text' },
            }],
          },
        }],
      },
    });
    const action = manifest.contributes.actions[0]!;
    const execution = action.execution;
    let executionReads = 0;
    // Counts the real registration-target schema read, which must not recur
    // for the same admitted declaration on each daemon catalog request.
    Object.defineProperty(action, 'execution', {
      get() { executionReads++; return execution; }, enumerable: true,
    });
    const field = manifest.contributes.voiceProviders[0]!.settings!.fields[0]!;
    const schema = field.schema;
    let schemaReads = 0;
    // The real Voice platform projector parses settings and compiles this
    // schema with AJV. Instrument its admitted input rather than the compiler.
    Object.defineProperty(field, 'schema', {
      get() { schemaReads++; return schema; }, enumerable: true,
    });
    const project = (generation: number, source: 'bundled' | 'development' = 'bundled') => (
      projectManifestContributionIntrospection({
        manifest, source, generation, host: 'daemon', platform: 'darwin',
        occurredAtMs: generation, diagnostics: [],
      })
    );
    expect(project(1)).toMatchObject({ generation: 1 });
    const firstReads = executionReads;
    const firstSchemaReads = schemaReads;
    expect(firstReads).toBeGreaterThan(0);
    expect(firstSchemaReads).toBeGreaterThan(0);
    expect(project(2)).toMatchObject({ generation: 2 });
    expect(project(3)).toMatchObject({ generation: 3 });
    expect(executionReads).toBe(firstReads);
    expect(schemaReads).toBe(firstSchemaReads);
    project(4, 'development');
    expect(collectManifestContributionIntrospectionCandidates({ manifest, source: 'development' })[0]?.source)
      .toBe('development');
    expect(executionReads).toBeGreaterThan(firstReads);

    const replacement = normalizePluginManifestV2({
      ...manifest, version: '2.0.0',
      contributes: { actions: [{ ...action, id: 'replacement' }] },
    });
    expect(projectManifestContributionIntrospection({
      manifest: replacement, source: 'bundled', generation: 5, host: 'daemon',
      platform: 'darwin', occurredAtMs: 5, diagnostics: [],
    }).contributions).toEqual([expect.objectContaining({
      contribution: expect.objectContaining({ qualifiedId: 'acme.retained/actions/replacement' }),
    })]);
    expect(collectManifestContributionIntrospectionCandidates({ manifest: replacement, source: 'bundled' })[0]?.pluginVersion)
      .toBe('2.0.0');
  });

  it('projects admitted contribution metadata without traversing executable payloads again', () => {
    const manifest = normalizePluginManifestV2({
      schemaVersion: 2,
      id: 'acme.manifest',
      version: '1.0.0',
      displayName: 'Manifest',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: {
        actions: [{
          id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'],
          execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe',
          inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
        }],
      },
    });
    const action = manifest.contributes.actions[0]!;
    // Instrument the already-admitted payload, not an internal service. Catalog
    // metadata must remain readable without revisiting its potentially large
    // executable JSON schema; manifest admission above keeps validation real.
    Object.defineProperty(action, 'inputSchema', {
      get() { throw new Error('Catalog projection traversed an already-admitted executable payload'); },
      enumerable: true,
    });

    expect(projectManifestContributionIntrospection({
      manifest, source: 'development', generation: 0, host: 'cli',
      platform: 'darwin', occurredAtMs: 1, diagnostics: [],
    }).contributions).toEqual([expect.objectContaining({
      contribution: expect.objectContaining({ qualifiedId: 'acme.manifest/actions/run' }),
      registration: { requirement: 'required', state: 'unbound' },
    })]);
  });

  it('uses the executable catalog rather than a partial hand-maintained family list', () => {
    const manifest = normalizePluginManifestV2({
      schemaVersion: 2,
      id: 'acme.manifest',
      version: '1.0.0',
      displayName: 'Manifest',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: {
        actions: [{
          id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'],
          execution: { target: 'daemon' },
          placementBindings: ['primary'], dangerLevel: 'safe',
        }],
        commands: [{ id: 'command', title: 'Command', path: ['run'], action: 'run' }],
        composerReferences: [{
          id: 'issues',
          title: 'Issues',
          description: 'Search issues',
          icon: 'search',
          triggers: ['$'],
        }],
        voiceModelPacks: [],
      },
    });

    const projection = projectManifestContributionIntrospection({
      manifest,
      source: 'development',
      generation: 0,
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 1,
      diagnostics: [],
    });

    expect(projection.contributions.map((entry) => entry.contribution.family)).toEqual([
      'actions',
      'commands',
      'composerReferences',
    ]);
    expect(projection.contributions.find((entry) => entry.contribution.family === 'composerReferences'))
      .toMatchObject({
        presentation: {
          kind: 'composerReference',
          title: 'Issues',
          description: 'Search issues',
          icon: 'search',
          triggers: ['$'],
        },
      });
    expect(projection.contributions.every((entry) => entry.progression.merged === false)).toBe(true);
  });
});
