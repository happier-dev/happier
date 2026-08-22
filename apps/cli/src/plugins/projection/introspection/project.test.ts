import { describe, expect, it } from 'vitest';

import { PLUGIN_CONTRIBUTION_CATALOG_V2, type PluginDiagnosticDataV1 } from '@happier-dev/protocol';

import {
  enrichPluginDiagnosticRecord,
  projectPluginContributionIntrospection,
  readPluginDiagnosticDisplayMessage,
  type PluginContributionIntrospectionCandidate,
} from './project';

const action: PluginContributionIntrospectionCandidate = {
  pluginId: 'acme.example',
  pluginVersion: '1.0.0',
  source: 'development',
  family: 'actions',
  identity: { kind: 'localId', localId: 'run' },
  registration: 'required',
  consumer: 'action-dispatch',
  platforms: ['cli', 'web'],
};

describe('plugin contribution lifecycle introspection', () => {
  it('reads display text from canonical diagnostic data with a code fallback', () => {
    const context = {
      ordinal: 0,
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' as const },
      stage: 'normalization' as const,
      host: 'cli' as const,
      platform: 'darwin',
      occurredAtMs: 10,
    };

    expect(readPluginDiagnosticDisplayMessage(enrichPluginDiagnosticRecord({
      code: 'target_absent',
      severity: 'error',
      message: 'Targeted contribution admission rejected.',
    }, context))).toBe('Targeted contribution admission rejected.');
    expect(readPluginDiagnosticDisplayMessage(enrichPluginDiagnosticRecord({
      code: 'target_absent',
      severity: 'error',
    }, context))).toBe('target_absent');
  });

  it('preserves an author source location while re-redacting a published diagnostic record', () => {
    const record = enrichPluginDiagnosticRecord({
      code: 'plugin_activation_failed',
      severity: 'error',
      message: "src/daemon.ts:7:19: Cannot find module 'left-pad' from /Users/alice/private/store",
    }, {
      ordinal: 0,
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      stage: 'activation',
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 10,
    });

    const message = record.data.message ?? '';
    expect(message).toContain('src/daemon.ts:7:19');
    expect(message).toContain('[REDACTED_PATH]');
    expect(message).not.toContain('/Users/alice/private/store');
  });

  it('projects persistent diagnostic failure text through the shared redacted head bound', () => {
    const record = enrichPluginDiagnosticRecord({
      code: 'target_absent',
      severity: 'error',
      message: [
        'BEGIN_FAILURE client_secret=introspection-secret',
        'https://alice:introspection-userinfo@example.test/load?access_token=introspection-query-secret&safe=yes',
        '🙂'.repeat(1_200),
        'END_STACK',
      ].join(' '),
    }, {
      ordinal: 0,
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      stage: 'activation',
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 10,
    });

    const message = record.data.message ?? '';
    expect(message).toMatch(/^BEGIN_FAILURE/u);
    expect(message).not.toContain('introspection-secret');
    expect(message).not.toContain('introspection-userinfo');
    expect(message).not.toContain('introspection-query-secret');
    expect(message).not.toContain('END_STACK');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('accounts for all public catalog entries exactly once', () => {
    const candidates: PluginContributionIntrospectionCandidate[] = PLUGIN_CONTRIBUTION_CATALOG_V2.map((entry) => ({
      pluginId: 'acme.all-families',
      pluginVersion: '1.0.0',
      source: 'development',
      family: entry.manifestKey,
      identity: entry.identityKind === 'locale'
        ? { kind: 'locale' as const, locale: 'en-US' }
        : entry.identityKind === 'delegatedDomain'
          ? { kind: 'delegatedDomain' as const, domainId: 'gateway' }
          : { kind: 'localId' as const, localId: entry.manifestKey.replaceAll('.', '-') },
      registration: entry.activationDemand === 'registration' ? 'required' : 'notRequired',
      consumer: entry.consumer,
      platforms: entry.platforms,
    }));
    const projection = projectPluginContributionIntrospection({
      generation: 1,
      candidates,
      diagnostics: [],
    });

    expect(projection.contributions).toHaveLength(PLUGIN_CONTRIBUTION_CATALOG_V2.length);
    expect(new Set(projection.contributions.map((entry) => entry.contribution.family))).toEqual(
      new Set(PLUGIN_CONTRIBUTION_CATALOG_V2.map((entry) => entry.manifestKey)),
    );
  });

  it('projects required and descriptor-only candidates through one honest static lifecycle owner', () => {
    const projection = projectPluginContributionIntrospection({
      generation: 3,
      candidates: [
        action,
        {
          ...action,
          family: 'commands',
          identity: { kind: 'localId', localId: 'run-command' },
          registration: 'notRequired',
          consumer: 'cli-commands',
          platforms: ['cli'],
        },
      ],
      diagnostics: [],
    });

    expect(projection.contributions).toHaveLength(2);
    expect(projection.contributions[0]).toMatchObject({
      contribution: { qualifiedId: 'acme.example/actions/run' },
      registration: { requirement: 'required', state: 'unbound' },
      activation: { state: 'dormant' },
      projection: { state: 'projected' },
    });
    expect(projection.contributions[1]).toMatchObject({
      contribution: { qualifiedId: 'acme.example/commands/run-command' },
      registration: { requirement: 'notRequired', state: 'notRequired' },
      activation: { state: 'notRequired' },
      projection: { state: 'projected' },
    });
    expect(projection.contributions.every((entry) => !('definition' in entry))).toBe(true);
  });

  it('keeps locale, delegated-domain, and declarative voice identity distinct', () => {
    const projection = projectPluginContributionIntrospection({
      generation: 3,
      candidates: [
        {
          ...action,
          family: 'ui.translations',
          identity: { kind: 'locale', locale: 'en-US' },
          registration: 'notRequired',
          consumer: 'ui-i18n-host',
        },
        {
          ...action,
          family: 'providers',
          identity: { kind: 'delegatedDomain', domainId: 'gateway' },
          registration: 'notRequired',
          consumer: 'providers-first-class',
        },
        {
          ...action,
          family: 'voiceModelPacks',
          identity: { kind: 'localId', localId: 'english-small' },
          registration: 'notRequired',
          consumer: 'voice-model-catalog',
        },
      ],
      diagnostics: [],
    });

    expect(projection.contributions.map((entry) => entry.contribution)).toEqual([
      expect.objectContaining({ kind: 'delegatedDomain', family: 'providers', domainId: 'gateway' }),
      expect.objectContaining({ kind: 'locale', family: 'ui.translations', locale: 'en-US' }),
      expect.objectContaining({ kind: 'localId', family: 'voiceModelPacks', localId: 'english-small' }),
    ]);
  });

  it('joins only explicit immutable runtime facts instead of inferring active state', () => {
    const projection = projectPluginContributionIntrospection({
      generation: 4,
      candidates: [action],
      diagnostics: [],
      runtimeFactsByQualifiedId: new Map([
        ['acme.example/actions/run', {
          registration: { requirement: 'required', state: 'bound', generation: 'runtime:4' },
          activation: { state: 'active', generation: 'runtime:4' },
          projection: { state: 'projected' },
        }],
      ]),
    });

    expect(projection.contributions[0]).toMatchObject({
      registration: { state: 'bound', generation: 'runtime:4' },
      activation: { state: 'active', generation: 'runtime:4' },
    });
  });

  it('rejects duplicate qualified contribution identities instead of projecting two lifecycle owners', () => {
    expect(() => projectPluginContributionIntrospection({
      generation: 4,
      candidates: [action, { ...action }],
      diagnostics: [],
    })).toThrow(/Duplicate contribution introspection identity/);
  });

  it('rejects runtime facts that contradict catalog-owned registration requirements', () => {
    expect(() => projectPluginContributionIntrospection({
      generation: 4,
      candidates: [action],
      diagnostics: [],
      runtimeFactsByQualifiedId: new Map([
        ['acme.example/actions/run', {
          registration: { requirement: 'notRequired', state: 'notRequired' },
          activation: { state: 'notRequired' },
          projection: { state: 'projected' },
        }],
      ]),
    })).toThrow(/registration requirement/);
  });

  it('rejects stale runtime facts that do not join a declared contribution', () => {
    expect(() => projectPluginContributionIntrospection({
      generation: 4,
      candidates: [action],
      diagnostics: [],
      runtimeFactsByQualifiedId: new Map([
        ['acme.example/actions/missing', {
          registration: { requirement: 'required', state: 'bound', generation: 'runtime:4' },
          activation: { state: 'active', generation: 'runtime:4' },
          projection: { state: 'projected' },
        }],
      ]),
    })).toThrow(/unknown contribution introspection identity/);
  });

  it('enriches author diagnostic data once with host-owned facts and preserves repeated diagnostics', () => {
    const data: PluginDiagnosticDataV1 = {
      code: 'not_ready',
      severity: 'error',
      message: 'Not ready',
    };
    const first = enrichPluginDiagnosticRecord(data, {
      ordinal: 0,
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      contribution: {
        pluginId: 'acme.example',
        localId: 'run',
      },
      stage: 'normalization',
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 10,
    });
    const second = enrichPluginDiagnosticRecord(data, {
      ordinal: 0,
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      contribution: {
        pluginId: 'acme.example',
        localId: 'run-command',
      },
      stage: 'activation',
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 11,
    });

    const projection = projectPluginContributionIntrospection({
      generation: 1,
      candidates: [],
      diagnostics: [first, second],
    });
    expect(projection.diagnostics).toHaveLength(2);
    expect(projection.diagnostics[0]?.id).not.toBe(projection.diagnostics[1]?.id);
  });
});
