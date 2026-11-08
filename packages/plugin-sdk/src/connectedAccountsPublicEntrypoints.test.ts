import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ConnectedAccountAuthCompletionResult, ConnectedAccountFailureRetryEvidence } from '@happier-dev/cli-common/connectedAccounts';

import * as connectedAccounts from './connected-accounts/index.public.js';
import * as connectedAccountsRuntime from './connected-accounts/index.js';
import * as providerLimitEvidence from './cloud/providerLimitEvidence.js';

const FIRST_PARTY_FACT_EXPORTS = Object.freeze([
  'CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1',
  'CLAUDE_SUBSCRIPTION_OAUTH_PROFILE',
  'CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1',
  'CODEX_NATIVE_HOME',
  'CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME',
  'OPENAI_CODEX_OAUTH_PROFILE',
] as const);

const FIRST_PARTY_FACT_TYPE_EXPORTS = Object.freeze([
  'ClaudeSubscriptionMaterializationContractV1',
  'ClaudeSubscriptionSetupTokenEnvironmentRequestV1',
] as const);

describe('Connected Accounts public entrypoint policy boundary', () => {
  it('publishes generic provider-limit evidence through the Connected Accounts author path', () => {
    for (const exportName of [
      'PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1',
      'classifyProviderLimitEvidence',
    ] as const) {
      expect(connectedAccounts[exportName]).toBe(providerLimitEvidence[exportName]);
      expect(connectedAccountsRuntime[exportName]).toBe(providerLimitEvidence[exportName]);
    }
  });

  it('publishes the generic author path without the retired first-party facade', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toHaveProperty('./connected-accounts');
    expect(packageJson.exports).not.toHaveProperty('./first-party/connected-accounts');
  });

  it('keeps Happier Connected Account facts off the generic entrypoint', () => {
    for (const exportName of FIRST_PARTY_FACT_EXPORTS) {
      expect(Reflect.has(connectedAccounts, exportName)).toBe(false);
      expect(Reflect.has(connectedAccountsRuntime, exportName)).toBe(false);
    }
  });

  it('keeps first-party policy types out of generic author declarations', () => {
    const genericSource = readFileSync(new URL('./connected-accounts/index.public.ts', import.meta.url), 'utf8');
    const genericRuntimeSource = readFileSync(new URL('./connected-accounts/index.ts', import.meta.url), 'utf8');

    for (const exportName of FIRST_PARTY_FACT_TYPE_EXPORTS) {
      expect(genericSource).not.toContain(exportName);
      expect(genericRuntimeSource).not.toContain(exportName);
    }
  });

  it('keeps result-composition helpers private while publishing exact discriminated results', () => {
    expectTypeOf<connectedAccounts.ConnectedAccountFailureRetryEvidence>()
      .toEqualTypeOf<ConnectedAccountFailureRetryEvidence>();
    expectTypeOf<connectedAccounts.ConnectedAccountAuthCompletionResult>()
      .toEqualTypeOf<ConnectedAccountAuthCompletionResult>();
  });
});
