import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as connectedAccounts from './connected-accounts/index.public.js';
import * as connectedAccountsRuntime from './connected-accounts/index.js';
import * as firstPartyConnectedAccounts from './first-party/connected-accounts/index.public.js';

const FIRST_PARTY_FACT_EXPORTS = Object.freeze([
  'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
  'CLAUDE_SUBSCRIPTION_OAUTH_PROFILE',
  'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
  'OPENAI_CODEX_OAUTH_PROFILE',
  'PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1',
  'classifyProviderLimitEvidence',
] as const);

const FIRST_PARTY_FACT_TYPE_EXPORTS = Object.freeze([
  'ClaudeSubscriptionMaterializationContractV1',
  'ClaudeSubscriptionSetupTokenEnvironmentRequestV1',
  'ProviderLimitCategory',
  'ProviderLimitEvidenceClassification',
  'ProviderLimitEvidenceConfidence',
  'ProviderLimitEvidenceContext',
  'ProviderLimitEvidenceProvenance',
] as const);

describe('Connected Accounts public entrypoint policy boundary', () => {
  it('publishes both the generic author path and the focused first-party fact path', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toHaveProperty('./connected-accounts');
    expect(packageJson.exports).toHaveProperty('./first-party/connected-accounts');
  });

  it('keeps Happier Connected Account facts off the generic entrypoint and on the focused first-party entrypoint', () => {
    for (const exportName of FIRST_PARTY_FACT_EXPORTS) {
      expect(Reflect.has(connectedAccounts, exportName)).toBe(false);
      expect(Reflect.has(connectedAccountsRuntime, exportName)).toBe(false);
      expect(Reflect.has(firstPartyConnectedAccounts, exportName)).toBe(true);
    }
  });

  it('owns first-party policy types only from the focused first-party declaration source', () => {
    const genericSource = readFileSync(new URL('./connected-accounts/index.public.ts', import.meta.url), 'utf8');
    const genericRuntimeSource = readFileSync(new URL('./connected-accounts/index.ts', import.meta.url), 'utf8');
    const firstPartySource = readFileSync(
      new URL('./first-party/connected-accounts/index.public.ts', import.meta.url),
      'utf8',
    );

    for (const exportName of FIRST_PARTY_FACT_TYPE_EXPORTS) {
      expect(genericSource).not.toContain(exportName);
      expect(genericRuntimeSource).not.toContain(exportName);
      expect(firstPartySource).toContain(exportName);
    }
  });

  it('keeps result-composition helpers private while publishing exact discriminated results', () => {
    const genericSource = readFileSync(new URL('./connected-accounts/index.public.ts', import.meta.url), 'utf8');
    const serviceSource = readFileSync(new URL('./services/connectedAccounts.ts', import.meta.url), 'utf8');

    expect(genericSource).toContain('ConnectedAccountFailureRetryEvidence');
    expect(serviceSource).toContain('export type PluginConnectedAccountFailureRetryEvidence');
    expect(serviceSource).toContain("status: 'rejected';");
    expect(serviceSource).toContain("status: 'unavailable';");
  });
});
