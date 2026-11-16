import { describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { areExecutionRunBackendTargetsEqual, resolveExecutionRunRuntimeBackendTarget } from './backendTargets';

// The fixture's publication policy imports fs. Load it before replacing that
// boundary, as in ExecutionRunHostBridge.registry.test.ts.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  import('@/plugins/projection/registry/builtIn/locators.testkit')
));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

describe('concrete Custom ACP execution-run targets', () => {
  it('preserves definition identity through comparison and runtime lowering at the real catalog', () => {
    const target = { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'definition-a' };
    expect(areExecutionRunBackendTargetsEqual(target, buildBackendTargetKeyV2(target))).toBe(true);
    expect(areExecutionRunBackendTargetsEqual(target, { ...target, definitionId: 'definition-b' })).toBe(false);
    expect(areExecutionRunBackendTargetsEqual(target, { kind: 'configuredAcpBackend', backendId: 'definition-a' })).toBe(true);
    expect(resolveExecutionRunRuntimeBackendTarget(target)).toEqual({ kind: 'configuredAcpBackend', backendId: 'definition-a' });
  });
});
