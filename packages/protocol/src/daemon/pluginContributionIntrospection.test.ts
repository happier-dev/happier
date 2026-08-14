import { describe, expect, it } from 'vitest';

import {
  PluginContributionIntrospectionProjectionV1Schema,
  PluginContributionLifecycleRecordV1Schema,
  PluginDiagnosticRecordV1Schema,
} from './pluginContributionIntrospection.js';

const contribution = {
  kind: 'localId',
  pluginId: 'acme.example',
  family: 'actions',
  localId: 'run',
  qualifiedId: 'acme.example/actions/run',
} as const;

describe('plugin contribution introspection wire contract', () => {
  it('preserves local, locale, and delegated-domain identities without collapsing them', () => {
    const contributionBase = {
      version: 1,
      stability: 'stable',
      progression: { declared: true, normalized: true, merged: true },
      registration: { requirement: 'notRequired', state: 'notRequired' },
      activation: { state: 'notRequired' },
      projection: { state: 'projected' },
      consumer: 'test-consumer',
      platforms: ['cli'],
      diagnostics: [],
    } as const;

    const locale = PluginContributionLifecycleRecordV1Schema.parse({
      ...contributionBase,
      contribution: {
        kind: 'locale',
        pluginId: 'acme.example',
        family: 'ui.translations',
        locale: 'en-US',
        qualifiedId: 'acme.example/ui.translations/en-US',
      },
    });
    const delegated = PluginContributionLifecycleRecordV1Schema.parse({
      ...contributionBase,
      stability: 'delegated',
      contribution: {
        kind: 'delegatedDomain',
        pluginId: 'acme.example',
        family: 'providers',
        domainId: 'gateway',
        qualifiedId: 'acme.example/providers/gateway',
      },
    });

    expect(locale.contribution).toMatchObject({ kind: 'locale', locale: 'en-US' });
    expect(locale.contribution).not.toHaveProperty('localId');
    expect(delegated.contribution).toMatchObject({ kind: 'delegatedDomain', domainId: 'gateway' });
    expect(delegated.contribution).not.toHaveProperty('localId');
    expect(PluginContributionLifecycleRecordV1Schema.safeParse({
      ...contributionBase,
      contribution: {
        kind: 'mystery',
        pluginId: 'acme.example',
        family: 'ui.translations',
        localId: 'en-US',
        qualifiedId: 'acme.example/ui.translations/en-US',
      },
    }).success).toBe(false);
  });

  it('preserves the full static lifecycle progression without claiming runtime binding', () => {
    const parsed = PluginContributionLifecycleRecordV1Schema.parse({
      version: 1,
      contribution,
      stability: 'stable',
      progression: {
        declared: true,
        normalized: true,
        merged: true,
      },
      registration: {
        requirement: 'required',
        state: 'unbound',
      },
      activation: { state: 'dormant' },
      projection: { state: 'projected' },
      consumer: 'action-dispatch',
      platforms: ['cli', 'web'],
      diagnostics: [],
    });

    expect(parsed.registration).toEqual({ requirement: 'required', state: 'unbound' });
    expect(parsed.activation).toEqual({ state: 'dormant' });
    expect(parsed).not.toHaveProperty('definition');
  });

  it('represents descriptor-only contributions as not requiring registration', () => {
    const parsed = PluginContributionLifecycleRecordV1Schema.parse({
      version: 1,
      contribution: { ...contribution, family: 'commands', qualifiedId: 'acme.example/commands/run' },
      stability: 'stable',
      progression: { declared: true, normalized: true, merged: true },
      registration: { requirement: 'notRequired', state: 'notRequired' },
      activation: { state: 'notRequired' },
      projection: { state: 'projected' },
      consumer: 'cli-commands',
      platforms: ['cli'],
      diagnostics: [],
    });

    expect(parsed.registration.state).toBe('notRequired');
    expect(parsed.activation.state).toBe('notRequired');
  });

  it('rejects unknown lifecycle and diagnostic stages instead of passing them through', () => {
    const base = {
      version: 1,
      contribution,
      stability: 'stable',
      progression: { declared: true, normalized: true, merged: true },
      registration: { requirement: 'required', state: 'unbound' },
      activation: { state: 'dormant' },
      projection: { state: 'projected' },
      consumer: 'action-dispatch',
      platforms: ['cli'],
      diagnostics: [],
    };

    expect(PluginContributionLifecycleRecordV1Schema.safeParse({
      ...base,
      activation: { state: 'waitingForMagic' },
    }).success).toBe(false);
    expect(PluginDiagnosticRecordV1Schema.safeParse({
      version: 1,
      id: 'diag-1',
      data: { code: 'broken', severity: 'error' },
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      stage: 'postMagic',
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 1,
      resolution: { state: 'current' },
    }).success).toBe(false);
  });

  it('does not deduplicate diagnostics that share code and message across stages or contributions', () => {
    const diagnostic = {
      version: 1,
      data: { code: 'not_ready', severity: 'error', message: 'Not ready' },
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 1,
      resolution: { state: 'current' },
    } as const;
    const first = {
      ...diagnostic,
      id: 'normalization-actions',
      stage: 'normalization',
      contribution: { pluginId: 'acme.example', localId: 'run' },
    };
    const second = {
      ...diagnostic,
      id: 'activation-commands',
      stage: 'activation',
      contribution: { pluginId: 'acme.example', localId: 'run-command' },
    };

    const parsed = PluginContributionIntrospectionProjectionV1Schema.parse({
      version: 1,
      generation: 0,
      contributions: [],
      diagnostics: [first, second],
    });

    expect(parsed.diagnostics).toHaveLength(2);
    expect(parsed.diagnostics.map((entry) => entry.id)).toEqual([
      'normalization-actions',
      'activation-commands',
    ]);
    expect(PluginDiagnosticRecordV1Schema.safeParse({
      ...first,
      contribution,
    }).success).toBe(false);
  });

  it('rejects impossible registration and activation combinations', () => {
    const base = {
      version: 1,
      contribution,
      stability: 'stable',
      progression: { declared: true, normalized: true, merged: true },
      projection: { state: 'projected' },
      consumer: 'action-dispatch',
      platforms: ['cli'],
      diagnostics: [],
    } as const;

    expect(PluginContributionLifecycleRecordV1Schema.safeParse({
      ...base,
      registration: { requirement: 'required', state: 'unbound' },
      activation: { state: 'active', generation: 'runtime:1' },
    }).success).toBe(false);
    expect(PluginContributionLifecycleRecordV1Schema.safeParse({
      ...base,
      registration: { requirement: 'notRequired', state: 'notRequired' },
      activation: { state: 'dormant' },
    }).success).toBe(false);
  });

  it('rejects diagnostic and lifecycle reason text beyond the wire UTF-8 bound', () => {
    const oversized = '🙂'.repeat(513);
    const record = {
      version: 1,
      id: 'diag-oversized',
      data: { code: 'broken', severity: 'error', message: oversized },
      plugin: { id: 'acme.example', version: '1.0.0', source: 'development' },
      stage: 'activation',
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 1,
      resolution: { state: 'current' },
    } as const;

    expect(PluginDiagnosticRecordV1Schema.safeParse(record).success).toBe(false);
    expect(PluginContributionLifecycleRecordV1Schema.safeParse({
      version: 1,
      contribution,
      stability: 'stable',
      progression: { declared: true, normalized: true, merged: true },
      registration: { requirement: 'required', state: 'unavailable', reason: oversized },
      activation: { state: 'dormant' },
      projection: { state: 'projected' },
      consumer: 'test-consumer',
      platforms: ['cli'],
      diagnostics: [],
    }).success).toBe(false);
  });
});
