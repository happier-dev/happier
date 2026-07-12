import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: Grok provider contracts', () => {
  it('discovers the real provider with API-key-or-host auth and canonical Grok binary override', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const grok = providers.find((provider) => provider.id === 'grok');

    expect(grok).toBeDefined();
    expect(grok?.protocol).toBe('acp');
    expect(grok?.auth).toMatchObject({
      mode: 'auto',
      env: { requiredAnyOf: [['XAI_API_KEY']] },
    });
    expect(grok?.requiredEnv).toBeUndefined();
    expect(grok?.requiresBinaries).toContainEqual({
      bin: 'grok',
      envOverride: 'HAPPIER_E2E_PROVIDER_GROK_BIN',
      requireExists: true,
    });
    expect(grok?.cli).toMatchObject({
      subcommand: 'grok',
      envFrom: { HAPPIER_GROK_PATH: 'HAPPIER_E2E_PROVIDER_GROK_BIN' },
    });
  });

  it('discovers the deterministic Grok ACP boundary fake without requiring credentials', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const stub = providers.find((provider) => provider.id === 'grok_acp_stub');

    expect(stub).toBeDefined();
    expect(stub?.protocol).toBe('acp');
    expect(stub?.requiredEnv).toBeUndefined();
    expect(stub?.cli.subcommand).toBe('grok');
    expect(stub?.cli.env?.HAPPIER_GROK_PATH).toContain('grok-acp-stub-provider.mjs');
    expect(stub?.scenarioRegistry.tiers.smoke).toEqual(expect.arrayContaining([
      'grok_acp_stub_auth_create_resume',
      'grok_acp_stub_structured_question',
      'grok_acp_stub_cancel_and_capabilities',
    ]));
  });
});
