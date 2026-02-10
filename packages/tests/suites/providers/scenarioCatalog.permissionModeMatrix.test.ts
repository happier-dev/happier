import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function providerStub(params: {
  id: string;
  promptsByMode: Record<string, boolean>;
}): ProviderUnderTest {
  return {
    id: params.id,
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
    protocol: 'acp',
    traceProvider: params.id,
    permissions: {
      v: 1,
      acp: {
        toolPermissionPromptsByMode: params.promptsByMode as any,
        outsideWorkspaceWriteAllowedByMode: {
          default: true,
          'safe-yolo': true,
          'read-only': false,
          yolo: true,
          plan: false,
        } as any,
        outsideWorkspaceWriteMustCompleteByMode: {
          default: true,
          'safe-yolo': true,
          'read-only': false,
          yolo: true,
          plan: false,
        } as any,
      } as any,
    },
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: params.id },
  };
}

function resolveMeta(scenario: ReturnType<typeof scenarioCatalog.permission_surface_outside_workspace>) {
  return typeof scenario.messageMeta === 'function'
    ? scenario.messageMeta({ workspaceDir: '/tmp' })
    : (scenario.messageMeta ?? {});
}

describe('scenarioCatalog: ACP permission mode matrix scenarios', () => {
  it('builds mode-scoped outside-workspace scenarios with permission expectations', () => {
    const provider = providerStub({
      id: 'opencode',
      promptsByMode: {
        default: true,
        'safe-yolo': true,
        'read-only': false,
        yolo: false,
      },
    });

    const modeIds = [
      'permission_mode_default_outside_workspace',
      'permission_mode_safe_yolo_outside_workspace',
      'permission_mode_read_only_outside_workspace',
      'permission_mode_yolo_outside_workspace',
    ] as const;

    for (const id of modeIds) {
      const scenario = scenarioCatalog[id](provider);
      expect(scenario.id).toBe(id);
      expect((scenario.tier ?? 'extended')).toBe('extended');
    }

    const defaultScenario = scenarioCatalog.permission_mode_default_outside_workspace(provider);
    const safeScenario = scenarioCatalog.permission_mode_safe_yolo_outside_workspace(provider);
    const readonlyScenario = scenarioCatalog.permission_mode_read_only_outside_workspace(provider);
    const yoloScenario = scenarioCatalog.permission_mode_yolo_outside_workspace(provider);

    expect(resolveMeta(defaultScenario).permissionMode).toBe('default');
    expect(resolveMeta(safeScenario).permissionMode).toBe('safe-yolo');
    expect(resolveMeta(readonlyScenario).permissionMode).toBe('read-only');
    expect(resolveMeta(yoloScenario).permissionMode).toBe('yolo');

    const defaultKeys = (defaultScenario.requiredAnyFixtureKeys ?? []).flat();
    const readonlyKeys = (readonlyScenario.requiredAnyFixtureKeys ?? []).flat();
    const yoloKeys = (yoloScenario.requiredAnyFixtureKeys ?? []).flat();

    expect(defaultKeys.some((key) => key.includes('/permission-request/'))).toBe(true);
    expect(readonlyKeys.some((key) => key.includes('/permission-request/'))).toBe(false);
    expect(yoloKeys.some((key) => key.includes('/permission-request/'))).toBe(false);

    expect(defaultScenario.permissionAutoDecision).toBe('approved_for_session');
    expect(safeScenario.permissionAutoDecision).toBe('approved_for_session');
    expect(readonlyScenario.permissionAutoDecision).toBe('denied');
    expect(yoloScenario.permissionAutoDecision).toBe('approved');

    expect(defaultScenario.yolo).toBe(false);
    expect(safeScenario.yolo).toBe(false);
    expect(readonlyScenario.yolo).toBe(false);
    expect(yoloScenario.yolo).toBe(true);
    expect(yoloScenario.allowPermissionAutoApproveInYolo).toBe(true);
  });
});
