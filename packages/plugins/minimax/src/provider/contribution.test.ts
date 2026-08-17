import { describe, expect, it } from 'vitest';

import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import { MINIMAX_CN_PROVIDER_CONTRIBUTION, MINIMAX_PROVIDER_CONTRIBUTION } from './contribution.js';

const REGIONS = [
  {
    label: 'global',
    contribution: MINIMAX_PROVIDER_CONTRIBUTION,
    id: 'minimax',
    anthropicBaseUrl: 'https://api.minimax.io/anthropic',
    responsesBaseUrl: 'https://api.minimax.io/v1',
    legacySecret: 'MINIMAX_AUTH_TOKEN',
  },
  {
    label: 'China',
    contribution: MINIMAX_CN_PROVIDER_CONTRIBUTION,
    id: 'minimax-cn',
    anthropicBaseUrl: 'https://api.minimaxi.com/anthropic',
    responsesBaseUrl: 'https://api.minimaxi.com/v1',
    legacySecret: 'MINIMAX_CN_AUTH_TOKEN',
  },
] as const;

describe('MiniMax provider contributions', () => {
  it.each(REGIONS)('parses the $label contribution against the canonical schema', ({ contribution }) => {
    expect(() => ProviderContributionV1Schema.parse(contribution)).not.toThrow();
  });

  it.each(REGIONS)('pins the $label endpoints to their own regional host', ({
    contribution, id, anthropicBaseUrl, responsesBaseUrl,
  }) => {
    expect(contribution).toMatchObject({
      v: 1,
      id,
      kind: 'frontier',
      endpointTemplates: [
        { protocol: 'anthropic', baseUrl: anthropicBaseUrl },
        { protocol: 'openai-responses', baseUrl: responsesBaseUrl },
      ],
    });
  });

  it('never lets one region reach the other region\'s host', () => {
    // A key issued on one host is rejected by the other, so a cross-region base
    // URL would be a silent 401 rather than a visible misconfiguration.
    const globalUrls = MINIMAX_PROVIDER_CONTRIBUTION.endpointTemplates.map((endpoint) => endpoint.baseUrl);
    const cnUrls = MINIMAX_CN_PROVIDER_CONTRIBUTION.endpointTemplates.map((endpoint) => endpoint.baseUrl);
    expect(globalUrls.every((url) => url.includes('api.minimax.io'))).toBe(true);
    expect(cnUrls.every((url) => url.includes('api.minimaxi.com'))).toBe(true);
    expect(globalUrls.some((url) => cnUrls.includes(url))).toBe(false);
  });

  it.each(REGIONS)('offers $label bearer auth on every declared protocol', ({ contribution }) => {
    const protocols = contribution.endpointTemplates.map((endpoint) => endpoint.protocol);
    const transport = contribution.credential.transports[0];
    expect(transport?.destination).toEqual({ kind: 'httpHeader', name: 'Authorization', format: 'bearer' });
    // The Codex binding adapter only emits the clean `env_key` form for an
    // Authorization/bearer transport that covers openai-responses.
    expect([...transport?.protocols ?? []].sort()).toEqual([...protocols].sort());
  });

  it.each(REGIONS)('declares M3\'s extended-context variant for $label rather than hardcoding the suffix', ({ contribution }) => {
    expect(contribution.catalog.staticModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'MiniMax-M3',
        contextWindowTokens: 1_000_000,
        extendedContextModelId: 'MiniMax-M3[1m]',
      }),
    ]));
  });

  it.each(REGIONS)('migrates the $label legacy launch profile onto this connection', ({
    contribution, id, legacySecret, anthropicBaseUrl,
  }) => {
    const migration = contribution.legacyProfileMigrations[0];
    expect(migration).toMatchObject({
      sourceProfileId: id,
      credentialBinding: { legacyEnvVarName: legacySecret, credentialSlotId: 'apiKey' },
      primaryModel: { agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL', defaultModelId: 'MiniMax-M3' },
    });
    // The legacy profile pinned the `[1m]` id directly; it must land on the
    // canonical catalog model instead of a model the catalog does not list.
    expect(migration?.implicitModelAliasReplacements).toEqual([
      { legacyModelId: 'MiniMax-M3[1m]', replacementModelId: 'MiniMax-M3' },
    ]);
    expect(migration?.migratedEnvironmentVariables.map((entry) => entry.name)).toEqual([
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
    ]);
    expect(migration?.migratedEnvironmentVariables[0]?.value).toContain(anthropicBaseUrl);
  });

  it.each(REGIONS)('keeps the $label compaction window and tier aliases as retained profile settings', ({ contribution }) => {
    const retained = contribution.legacyProfileMigrations[0]?.retainedEnvironmentVariables.map((entry) => entry.name) ?? [];
    expect(retained).toEqual(expect.arrayContaining([
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]));
    // The provider connection owns routing; these stay profile-side because the
    // Claude binding adapter does not own model-tier or compaction settings.
    expect(retained).not.toContain('ANTHROPIC_BASE_URL');
  });

  it('uses distinct migration sources so both regional profiles can coexist', () => {
    expect(MINIMAX_PROVIDER_CONTRIBUTION.legacyProfileMigrations[0]?.sourceProfileId)
      .not.toBe(MINIMAX_CN_PROVIDER_CONTRIBUTION.legacyProfileMigrations[0]?.sourceProfileId);
  });
});
