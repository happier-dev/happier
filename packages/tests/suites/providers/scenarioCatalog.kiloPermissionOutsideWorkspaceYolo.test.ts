import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function providerStub(id: string): ProviderUnderTest {
  return {
    id,
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_KILO',
    protocol: 'acp',
    traceProvider: id,
    permissions: { v: 1, acp: { permissionSurfaceOutsideWorkspaceYolo: true } },
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog (kilo permissions)', () => {
  it('runs permission_surface_outside_workspace in yolo mode for kilo', () => {
    const scenario = scenarioCatalog.permission_surface_outside_workspace(providerStub('kilo'));
    expect(scenario.yolo).toBe(true);
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
  });
});
