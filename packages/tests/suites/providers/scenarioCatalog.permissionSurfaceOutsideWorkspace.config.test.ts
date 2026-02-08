import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function providerStub(params: {
  id: string;
  permissions?: ProviderUnderTest['permissions'];
}): ProviderUnderTest {
  return {
    id: params.id,
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
    protocol: 'acp',
    traceProvider: params.id,
    permissions: params.permissions,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: params.id },
  };
}

function buildPermissionSurfaceScenario(params: {
  id: string;
  permissions?: ProviderUnderTest['permissions'];
}) {
  return scenarioCatalog.permission_surface_outside_workspace(
    providerStub({
      id: params.id,
      permissions: params.permissions,
    }),
  );
}

function resolveScenarioMessageMeta(scenario: { messageMeta?: ProviderUnderTest['permissions'] | Record<string, unknown> | ((ctx: { workspaceDir: string }) => Record<string, unknown>) }) {
  const messageMeta = (scenario as any).messageMeta;
  return typeof messageMeta === 'function' ? messageMeta({ workspaceDir: '/tmp' }) : (messageMeta ?? {});
}

describe('scenarioCatalog (permission_surface_outside_workspace config)', () => {
  it('applies permission surface and prompt expectations from permissions config', () => {
    const cases = [
      {
        id: 'example',
        permissions: { v: 1, acp: { permissionSurfaceOutsideWorkspaceYolo: true } },
        expectedYolo: true,
        expectPermissionRequestFixture: false,
        expectedMessageMetaPermissionMode: 'yolo',
      },
      {
        id: 'kilo',
        permissions: {
          v: 1,
          acp: {
            expectToolPermissionPrompts: true,
            permissionSurfaceOutsideWorkspaceYolo: false,
          },
        },
        expectedYolo: false,
        expectPermissionRequestFixture: true,
        expectedMessageMetaPermissionMode: 'safe-yolo',
      },
    ] as const;

    for (const testCase of cases) {
      const scenario = buildPermissionSurfaceScenario({
        id: testCase.id,
        permissions: testCase.permissions,
      });
      expect(scenario.yolo).toBe(testCase.expectedYolo);
      const keys = (scenario.requiredAnyFixtureKeys ?? []).flat();
      expect(keys.some((key) => key.includes('/permission-request/'))).toBe(testCase.expectPermissionRequestFixture);
      const meta = resolveScenarioMessageMeta(scenario);
      expect(meta.permissionMode).toBe(testCase.expectedMessageMetaPermissionMode);
    }
  });

  it('uses approved_for_session auto-decision for OpenCode-family prompts', () => {
    const scenario = buildPermissionSurfaceScenario({
      id: 'opencode',
      permissions: {
        v: 1,
        acp: {
          expectToolPermissionPrompts: true,
          permissionSurfaceOutsideWorkspaceYolo: false,
        },
      },
    });

    expect(scenario.permissionAutoDecision).toBe('approved_for_session');
  });

  it('respects permissions.acp.expectToolPermissionPrompts for codex patch scenarios', () => {
    const provider = providerStub({
      id: 'codex',
      permissions: {
        v: 1,
        acp: {
          expectToolPermissionPrompts: false,
        },
      },
    });

    const approveScenario = scenarioCatalog.permission_surface_patch_apply(provider);
    const denyScenario = scenarioCatalog.permission_abort_patch_apply(provider);

    expect((approveScenario.requiredTraceSubstrings ?? []).some((k) => k.includes('permission-request'))).toBe(false);
    const denyMeta = resolveScenarioMessageMeta(denyScenario);
    expect(denyMeta.permissionMode).toBe('read-only');
  });
});
