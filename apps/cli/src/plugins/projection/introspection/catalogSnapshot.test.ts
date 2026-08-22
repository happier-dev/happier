import { describe, expect, it } from 'vitest';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import {
  joinInstalledCatalogRuntimeIntrospection,
  projectPluginCatalogEntriesSnapshot,
  projectPluginCatalogEntrySnapshot,
  resolveInstalledCatalogTargetActivationSnapshot,
} from './catalogSnapshot';

describe('plugin catalog introspection snapshot', () => {
  it('retains an attributed targeted-admission diagnostic in the CLI catalog snapshot', () => {
    const entry = {
      pluginId: 'acme.contributor', title: 'Contributor', description: null, version: '1.2.3', enabled: true,
      desiredGeneration: 'generation-1', appliedGeneration: 'generation-1', admittedIntegrity: null,
      source: { kind: 'path', locator: '/plugins/acme.contributor', trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: '/plugins/acme.contributor', manifestPath: '/plugins/acme.contributor/plugin.json' },
      install: { mode: 'link', manifestVersion: '1.2.3' }, compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/acme.contributor/plugin.json', manifest: null, diagnostics: [],
      contributionIntrospection: { version: 1, generation: 0, diagnostics: [], contributions: [] },
    } satisfies PluginCatalogEntry;

    const joined = joinInstalledCatalogRuntimeIntrospection([entry], {
      pluginDiagnosticsByPluginId: {
        'acme.contributor': [{
          code: 'point_absent',
          message: 'Targeted contribution admission rejected (point_absent).',
          stage: 'normalization',
          contribution: { pluginId: 'acme.contributor', localId: 'provider-a' },
          details: {
            targetPluginId: 'acme.target',
            pointId: 'providers',
            protocol: { id: 'provider', version: 1 },
          },
        }],
      },
    });

    expect(joined[0]?.contributionIntrospection.diagnostics).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'point_absent',
          details: {
            targetPluginId: 'acme.target',
            pointId: 'providers',
            protocol: { id: 'provider', version: 1 },
          },
        }),
        plugin: { id: 'acme.contributor', version: '1.2.3', source: 'localPath' },
        contribution: { pluginId: 'acme.contributor', localId: 'provider-a' },
        stage: 'normalization',
      }),
    ]);
    expect(projectPluginCatalogEntrySnapshot(joined[0]!).diagnostics)
      .toEqual(joined[0]!.contributionIntrospection.diagnostics);
  });

  it('returns one serialization model for CLI and dev-loop consumers', () => {
    const entry = {
      pluginId: 'acme.snapshot',
      desiredGeneration: 'generation-1',
      appliedGeneration: null,
      admittedIntegrity: null,
      title: 'Snapshot',
      description: null,
      version: '1.0.0',
      enabled: true,
      source: {
        kind: 'path', locator: '/plugins/acme.snapshot', trustPolicy: 'local_trusted',
        installPolicy: 'link', resolvedPath: '/plugins/acme.snapshot', manifestPath: '/plugins/acme.snapshot/plugin.json',
      },
      install: { mode: 'link', manifestVersion: '1.0.0' },
      compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/acme.snapshot/plugin.json',
      manifest: null,
      contributionIntrospection: {
        version: 1,
        generation: 0,
        contributions: [],
        diagnostics: [{
          version: 1,
          id: 'canonical-diagnostic',
          data: { code: 'broken', severity: 'error' },
          plugin: { id: 'acme.snapshot', version: '1.0.0', source: 'localPath' },
          stage: 'normalization',
          host: 'cli',
          platform: 'darwin',
          occurredAtMs: 1,
          resolution: { state: 'current' },
        }],
      },
      diagnostics: [{ code: 'plugin_manifest_invalid', message: 'Legacy compatibility diagnostic' }],
    } satisfies PluginCatalogEntry;

    expect(JSON.stringify(projectPluginCatalogEntrySnapshot(entry)))
      .toBe(JSON.stringify(projectPluginCatalogEntrySnapshot(entry)));
    expect(projectPluginCatalogEntrySnapshot(entry).contributions)
      .toBe(entry.contributionIntrospection);
    expect(projectPluginCatalogEntrySnapshot(entry).diagnostics)
      .toBe(entry.contributionIntrospection.diagnostics);
  });

  it('gives list, show, and dev-loop consumers the same generation-joined runtime snapshot', () => {
    const entry = {
      pluginId: 'acme.snapshot', title: 'Snapshot', description: null, version: '1.0.0', enabled: true,
      desiredGeneration: 'generation-1', appliedGeneration: null, admittedIntegrity: null,
      source: { kind: 'path', locator: '/plugins/acme.snapshot', trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: '/plugins/acme.snapshot', manifestPath: '/plugins/acme.snapshot/plugin.json' },
      install: { mode: 'link', manifestVersion: '1.0.0' }, compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/acme.snapshot/plugin.json', manifest: null, diagnostics: [],
      contributionIntrospection: {
        version: 1, generation: 0, diagnostics: [], contributions: [{
          version: 1,
          contribution: { pluginId: 'acme.snapshot', family: 'actions', qualifiedId: 'acme.snapshot/actions/run', kind: 'localId', localId: 'run' },
          progression: { declared: true, normalized: true, merged: false },
          registration: { requirement: 'required', state: 'unbound' }, activation: { state: 'dormant' },
          projection: { state: 'projected' }, consumer: 'action-dispatch', platforms: ['cli'], diagnostics: [],
        }],
      },
    } satisfies PluginCatalogEntry;
    const runtimeSnapshot = resolveInstalledCatalogTargetActivationSnapshot({
      entries: [entry], generation: 4, runtimeState: 'current',
      targetActivationFacts: [{
        pluginId: 'acme.snapshot', pluginVersion: '1.0.0', source: 'localPath',
        generation: '4', host: 'daemon', platform: 'darwin', occurredAtMs: 10,
        status: 'active',
        required: [{ family: 'actions', localId: 'run' }], bound: [{ family: 'actions', localId: 'run' }], diagnostics: [],
      }],
    });
    const snapshots = projectPluginCatalogEntriesSnapshot([entry], runtimeSnapshot);

    expect(snapshots[0]?.contributions).toMatchObject({
      generation: 4,
      contributions: [{ registration: { state: 'bound' }, activation: { state: 'active' } }],
    });
    expect(projectPluginCatalogEntriesSnapshot([entry], runtimeSnapshot)[0]).toEqual(snapshots[0]);
    expect(projectPluginCatalogEntrySnapshot(entry, runtimeSnapshot)).toEqual(snapshots[0]);

    const joinedEntries = joinInstalledCatalogRuntimeIntrospection([entry], {
      generation: 4,
      pluginFinalPolicyCurrentGenerationsById: new Map([['acme.snapshot', {
        immutableGenerationId: 'generation-1',
        desiredImmutableGenerationId: 'generation-1',
        appliedImmutableGenerationId: 'generation-1',
        distribution: { kind: 'localPath' },
        applied: true,
        selectedAccess: [],
      }]]),
      targetActivationFacts: [{
        pluginId: 'acme.snapshot', pluginVersion: '1.0.0', source: 'localPath',
        generation: '4', host: 'daemon', platform: 'darwin', occurredAtMs: 10,
        status: 'active',
        required: [{ family: 'actions', localId: 'run' }],
        bound: [{ family: 'actions', localId: 'run' }], diagnostics: [],
      }],
    });
    const listBytes = JSON.stringify(projectPluginCatalogEntriesSnapshot(joinedEntries));
    const showBytes = JSON.stringify(projectPluginCatalogEntrySnapshot(joinedEntries[0]!));
    const devLoopBytes = JSON.stringify(projectPluginCatalogEntriesSnapshot(joinedEntries));
    expect(showBytes).toBe(JSON.stringify(JSON.parse(listBytes)[0]));
    expect(devLoopBytes).toBe(listBytes);
    expect(joinedEntries[0]).toMatchObject({
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
    });
    expect(joinInstalledCatalogRuntimeIntrospection([entry], {
      pluginFinalPolicyCurrentGenerationsById: new Map([['acme.snapshot', {
        immutableGenerationId: 'generation-before-update',
        desiredImmutableGenerationId: 'generation-before-update',
        appliedImmutableGenerationId: 'generation-before-update',
        distribution: { kind: 'localPath' },
        applied: true,
        selectedAccess: [],
      }]]),
    })[0]).toMatchObject({
      desiredGeneration: 'generation-1',
      appliedGeneration: null,
    });
  });

  it('binds only daemon speech runtime demand in a mixed voice plugin while retaining the public projection family', () => {
    const manifest = normalizePluginManifestV2({
      schemaVersion: 2,
      id: 'acme.speech',
      version: '1.0.0',
      displayName: 'Speech',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      contributes: {
        voiceProviders: [{
          id: 'speech',
          title: 'Speech',
          kind: 'speech',
          roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
          platforms: ['web', 'ios', 'android'],
          settings: {
            schemaVersion: 2,
            fields: [{
              id: 'model',
              title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'synthetic-stt-v1',
              presentation: { control: 'text' },
            }, {
              id: 'voiceName',
              title: 'Voice',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'synthetic-voice-v1',
              presentation: { control: 'text' },
            }],
          },
        }, {
          id: 'conversation',
          title: 'Conversation',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: ['web'],
          capabilities: {
            turn: { cancelResponse: true, bargeIn: false },
          },
          client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
        }],
      },
    });
    const entry = {
      pluginId: 'acme.speech', title: 'Speech', description: null, version: '1.0.0', enabled: true,
      desiredGeneration: 'generation-1', appliedGeneration: null, admittedIntegrity: null,
      source: { kind: 'path', locator: '/plugins/acme.speech', trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: '/plugins/acme.speech', manifestPath: '/plugins/acme.speech/plugin.json' },
      install: { mode: 'link', manifestVersion: '1.0.0' }, compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/acme.speech/plugin.json', manifest, diagnostics: [],
      contributionIntrospection: {
        version: 1, generation: 0, diagnostics: [], contributions: [{
          version: 1,
          contribution: { pluginId: 'acme.speech', family: 'voiceProviders', qualifiedId: 'acme.speech/voiceProviders/speech', kind: 'localId', localId: 'speech' },
          progression: { declared: true, normalized: true, merged: false },
          registration: { requirement: 'required', state: 'unbound' }, activation: { state: 'dormant' },
          projection: { state: 'projected' }, consumer: 'voice-host', platforms: ['web', 'ios', 'android'], diagnostics: [],
        }, {
          version: 1,
          contribution: { pluginId: 'acme.speech', family: 'voiceProviders', qualifiedId: 'acme.speech/voiceProviders/conversation', kind: 'localId', localId: 'conversation' },
          progression: { declared: true, normalized: true, merged: false },
          registration: { requirement: 'required', state: 'unbound' }, activation: { state: 'dormant' },
          projection: { state: 'projected' }, consumer: 'voice-host', platforms: ['web', 'ios', 'android'], diagnostics: [],
        }],
      },
    } satisfies PluginCatalogEntry;

    const runtimeSnapshot = resolveInstalledCatalogTargetActivationSnapshot({
      entries: [entry], generation: 4, runtimeState: 'current',
      targetActivationFacts: [{
        pluginId: 'acme.speech', pluginVersion: '1.0.0', source: 'localPath',
        generation: '4', host: 'daemon', platform: 'darwin', occurredAtMs: 10,
        status: 'active',
        required: [{ family: 'voiceProviders', localId: 'speech' }],
        bound: [{ family: 'voiceProviders', localId: 'speech' }],
        diagnostics: [],
      }],
    });
    const contributions = projectPluginCatalogEntrySnapshot(entry, runtimeSnapshot)
      .contributions.contributions;
    const speech = contributions.find((candidate) => (
      candidate.contribution.kind === 'localId' && candidate.contribution.localId === 'speech'
    ))!;
    const conversation = contributions.find((candidate) => (
      candidate.contribution.kind === 'localId' && candidate.contribution.localId === 'conversation'
    ))!;

    expect(speech.contribution).toMatchObject({
      family: 'voiceProviders',
      qualifiedId: 'acme.speech/voiceProviders/speech',
    });
    expect(speech).toMatchObject({
      registration: { state: 'bound', generation: '4' },
      activation: { state: 'active', generation: '4' },
    });
    expect(conversation).toMatchObject({
      contribution: {
        family: 'voiceProviders',
        qualifiedId: 'acme.speech/voiceProviders/conversation',
      },
      registration: { state: 'unbound' },
      activation: { state: 'dormant' },
    });
  });

  it('retains registration-free failures and replaces cached activation diagnostics without double enrichment', () => {
    const entry = {
      pluginId: 'acme.snapshot', title: 'Snapshot', description: null, version: '1.0.0', enabled: true,
      desiredGeneration: 'generation-1', appliedGeneration: null, admittedIntegrity: null,
      source: { kind: 'path', locator: '/plugins/acme.snapshot', trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: '/plugins/acme.snapshot', manifestPath: '/plugins/acme.snapshot/plugin.json' },
      install: { mode: 'link', manifestVersion: '1.0.0' }, compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/acme.snapshot/plugin.json', manifest: null, diagnostics: [],
      contributionIntrospection: {
        version: 1, generation: 0, diagnostics: [], contributions: [{
          version: 1,
          contribution: { pluginId: 'acme.snapshot', family: 'ui.translations', qualifiedId: 'acme.snapshot/ui.translations/en-US', kind: 'locale', locale: 'en-US' },
          progression: { declared: true, normalized: true, merged: false },
          registration: { requirement: 'notRequired', state: 'notRequired' }, activation: { state: 'notRequired' },
          projection: { state: 'projected' }, consumer: 'ui-i18n-host', platforms: ['web'], diagnostics: [],
        }],
      },
    } satisfies PluginCatalogEntry;
    const fact = {
      pluginId: 'acme.snapshot', pluginVersion: '1.0.0', source: 'localPath' as const,
      generation: '4', host: 'daemon' as const, platform: 'darwin', occurredAtMs: 10,
      status: 'unavailable' as const, required: [], bound: [],
      diagnostics: [{ code: 'plugin_activation_failed' as const, message: 'Startup failed' }],
    };
    const current = resolveInstalledCatalogTargetActivationSnapshot({
      entries: [entry], generation: 4, runtimeState: 'current', targetActivationFacts: [fact],
    });
    const once = projectPluginCatalogEntriesSnapshot([entry], current)[0]!;
    const alreadyJoined = { ...entry, contributionIntrospection: once.contributions };
    const twice = projectPluginCatalogEntriesSnapshot([alreadyJoined], current)[0]!;

    expect(once.diagnostics).toHaveLength(1);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));

    const disposed = resolveInstalledCatalogTargetActivationSnapshot({
      entries: [entry], generation: 4, runtimeState: 'disposed', targetActivationFacts: [fact],
    });
    const afterDisposal = projectPluginCatalogEntriesSnapshot([alreadyJoined], disposed)[0]!;
    expect(afterDisposal.contributions.contributions[0]?.activation).toEqual({ state: 'notRequired' });
    expect(afterDisposal.diagnostics.map((diagnostic) => diagnostic.data.code)).toEqual([
      'plugin_activation_generation_disposed',
      'plugin_activation_failed',
    ]);
    expect(new Set(afterDisposal.diagnostics.map((diagnostic) => diagnostic.id)).size)
      .toBe(afterDisposal.diagnostics.length);
  });
});
