import { describe, expect, it } from 'vitest';

import { resolveAllowPermissionAutoApproveInYolo } from '../../src/testkit/providers/harness';
import type { ProviderScenario, ProviderUnderTest } from '../../src/testkit/providers/types';

function makeProvider(toolPermissionPromptsByModeYolo: boolean): ProviderUnderTest {
  return {
    id: 'kimi',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_KIMI',
    protocol: 'acp',
    traceProvider: 'kimi',
    permissions: {
      v: 1,
      acp: {
        toolPermissionPromptsByMode: {
          default: true,
          'safe-yolo': false,
          'read-only': false,
          yolo: toolPermissionPromptsByModeYolo,
          plan: false,
        },
      },
    },
    scenarioRegistry: {
      v: 1,
      tiers: { smoke: [], extended: [] },
    },
    cli: { subcommand: 'kimi' },
  };
}

describe('providers harness: yolo permission auto-approval policy', () => {
  it('uses provider yolo prompt capability when scenario does not override', () => {
    const scenario: ProviderScenario = { id: 's', title: 's', yolo: true, prompt: () => 'x' };
    const scenarioMeta = { permissionMode: 'yolo' };
    expect(
      resolveAllowPermissionAutoApproveInYolo({
        provider: makeProvider(true),
        scenario,
        scenarioMeta,
        yolo: true,
      }),
    ).toBe(true);
    expect(
      resolveAllowPermissionAutoApproveInYolo({
        provider: makeProvider(false),
        scenario,
        scenarioMeta,
        yolo: true,
      }),
    ).toBe(false);
  });

  it('honors scenario-level explicit override', () => {
    const scenario: ProviderScenario = {
      id: 's',
      title: 's',
      yolo: true,
      prompt: () => 'x',
      allowPermissionAutoApproveInYolo: true,
    };
    expect(
      resolveAllowPermissionAutoApproveInYolo({
        provider: makeProvider(false),
        scenario,
        scenarioMeta: { permissionMode: 'yolo' },
        yolo: true,
      }),
    ).toBe(true);
  });
});
