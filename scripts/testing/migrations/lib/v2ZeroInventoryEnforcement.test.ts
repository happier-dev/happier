import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enforceRuntimeCoreSessionCommandRoutingNoLoadRun,
  enforceAcpSharedSessionCompatibilityAllowlist,
  enforceRetiredRuntimeAdapterAliasAbsence,
  enforceExecutionRunIntentProfileOwnerFence,
  enforceExecutionRunBackendRegistryImportAllowlist,
  enforceTrackedV2ZeroReportFreshness,
  enforceSharedSessionCanonicalPlanBoundary,
  enforceSharedSessionRetirementSurfaceAllowlist,
  enforceSharedRuntimeForLoopCompatibilityRetirement,
  enforceV2ZeroInventoryBaseline,
  loadV2ZeroInventoryEnforcementBaseline,
} from './v2ZeroInventoryEnforcement.ts';
import {
  collectV2ZeroLaneExtractReports,
  formatV2ZeroLaneExtractMarkdown,
} from './v2ZeroLaneExtracts.ts';
import {
  collectV2ZeroSourceFiles,
  formatV2ZeroInventoryMarkdown,
  type V2ZeroInventoryReport,
} from './v2ZeroInventory.ts';

const legacyRuntimeLoopAliasName = ['Runtime', 'For', 'Loop'].join('');
const legacyBackendAliasName = ['Agent', 'Backend'].join('');
const legacyFactoryAliasName = ['Agent', 'Factory'].join('');

test('enforceV2ZeroInventoryBaseline fails closed when the report contains a category missing from the baseline', () => {
  const report: V2ZeroInventoryReport = {
    filesScanned: 1,
    filesMatched: 1,
    totalMatches: 1,
    categories: [
      {
        id: 'some-category',
        title: 'Some category',
        description: 'n/a',
        migrationScaffold: 'n/a',
        count: 123,
        files: ['apps/cli/src/foo.ts'],
      },
    ],
  };

  const result = enforceV2ZeroInventoryBaseline(report, { maxAllowedCounts: { 'other-category': 0 } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('some-category'));
});

test('enforceV2ZeroInventoryBaseline fails when a category exceeds maxAllowedCounts', () => {
  const report: V2ZeroInventoryReport = {
    filesScanned: 1,
    filesMatched: 1,
    totalMatches: 1,
    categories: [
      {
        id: 'shared-core-provider-branching',
        title: 'Shared/core provider-name branching',
        description: 'n/a',
        migrationScaffold: 'n/a',
        count: 2,
        files: ['apps/cli/src/agent/runtime/foo.ts', 'apps/cli/src/agent/runtime/bar.ts'],
      },
    ],
  };

  const result = enforceV2ZeroInventoryBaseline(report, { maxAllowedCounts: { 'shared-core-provider-branching': 1 } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('shared-core-provider-branching: 2 > maxAllowed 1'));
});

test('enforceV2ZeroInventoryBaseline keeps Voice V3-F contraction at hard zero and accepts a clean fixture', () => {
  const residueReport: V2ZeroInventoryReport = {
    filesScanned: 1,
    filesMatched: 1,
    totalMatches: 1,
    categories: [
      {
        id: 'voice-v3-f-v2-media-residue',
        title: 'Voice V3-F V2 media residue',
        description: 'n/a',
        migrationScaffold: 'n/a',
        count: 1,
        files: ['packages/protocol/src/machines/peer/mediation/renamedVoiceMedia.ts'],
      },
    ],
  };
  const baseline = { maxAllowedCounts: { 'voice-v3-f-v2-media-residue': 0 } };

  const residueResult = enforceV2ZeroInventoryBaseline(residueReport, baseline);
  const cleanResult = enforceV2ZeroInventoryBaseline({
    filesScanned: 1,
    filesMatched: 0,
    totalMatches: 0,
    categories: [],
  }, baseline);

  assert.equal(residueResult.ok, false);
  assert.match(residueResult.errors.join('\n'), /voice-v3-f-v2-media-residue: 1 > maxAllowed 0/);
  assert.deepEqual(cleanResult, { ok: true, errors: [] });
});

test('live V2-zero baseline matches the accepted bounded inventory ceilings that governance text relies on', () => {
  const baseline = loadV2ZeroInventoryEnforcementBaseline({
    rootDir: process.cwd(),
    baselinePath: 'scripts/testing/migrations/baselines/v2ZeroInventoryBaseline.json',
  });

  assert.equal(baseline.maxAllowedCounts['customacp-sentinel-consumers'], 32);
  assert.equal(baseline.maxAllowedCounts['builtin-cli-catalog-consumers'], 25);
  assert.equal(baseline.maxAllowedCounts['shared-core-provider-branching'], 58);
  assert.equal(baseline.maxAllowedCounts['hook-emission-sites'], 6);
  assert.equal(baseline.maxAllowedCounts['acp-shared-session-compatibility-surfaces'], 6);
  assert.equal(baseline.maxAllowedCounts['provider-session-loop-primitive-imports'], 0);
  assert.equal(baseline.maxAllowedCounts['execution-run-agentbackend-semantic-debt'], 0);
  assert.equal(baseline.maxAllowedCounts['runtimecore-create-session-runtime-whole-runner-delegation'], 0);
  assert.equal(baseline.maxAllowedCounts['voice-v3-f-v2-media-residue'], 0);
});

test('enforceExecutionRunBackendRegistryImportAllowlist fails when a non-allowlisted production file imports it', () => {
  const result = enforceExecutionRunBackendRegistryImportAllowlist([
    {
      filePath: 'apps/cli/src/agent/runtime/registry/createCliBindings.ts',
      content: "import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';",
    },
    {
      filePath: 'apps/cli/src/agent/runtime/registry/sneaky.ts',
      content: "import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';",
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('apps/cli/src/agent/runtime/registry/sneaky.ts'));
});

test('enforceExecutionRunBackendRegistryImportAllowlist accepts createCliBindings as the compatibility owner', () => {
  const result = enforceExecutionRunBackendRegistryImportAllowlist([
    {
      filePath: 'apps/cli/src/agent/runtime/registry/createCliBindings.ts',
      content: "import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';",
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceExecutionRunBackendRegistryImportAllowlist rejects descriptor helper registry imports', () => {
  const result = enforceExecutionRunBackendRegistryImportAllowlist([
    {
      filePath: 'apps/cli/src/agent/runtime/registry/createDescriptorExecutionRunBackend.ts',
      content: "import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';",
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('createDescriptorExecutionRunBackend.ts'));
});

test('enforceExecutionRunBackendRegistryImportAllowlist fails when executionRunBackendRegistry regains inline non-review descriptors', () => {
  const result = enforceExecutionRunBackendRegistryImportAllowlist([
    {
      filePath: 'apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts',
      content: `
import type { ExecutionRunBackendDescriptor } from './executionRunBackendTypes';

const REGISTRY: Record<string, ExecutionRunBackendDescriptor> = {
  codex: { factory: () => null as any },
};
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('executionRunBackendRegistry'));
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails if a runtimeCore-backed backend session command uses loadRun', async () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/sample/index.ts',
      content: `
export const sampleBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/command.ts',
      content: `
export const command = {
  loadRun: async () => ({ runSample: async () => null }),
};
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('loadRun'));
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails if a runtimeCore-backed backend session command does not declare backendIdForSessionRuntime', async () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/kilo/index.ts',
      content: `
export const kiloBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/kilo/cli/command.ts',
      content: `
export const command = {
  somethingElse: true,
};
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('backendIdForSessionRuntime'));
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails if backendIdForSessionRuntime does not match the backend folder id', async () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/opencode/index.ts',
      content: `
export const openCodeBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/opencode/cli/command.ts',
      content: `
export const command = {
  backendIdForSessionRuntime: 'not-opencode',
};
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('must match'));
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails when ACP catalog routing regresses to loadRun', async () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/customAcp/index.ts',
      content: `
export const customAcpBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/handleCatalogDefinedAcpCliCommand.ts',
      content: `
export async function handleCatalogDefinedAcpCliCommand() {
  return runBackendSessionCliCommand({
    loadRun: async () => ({ runCatalogDefinedAcpAgent: async () => null }),
  });
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('handleCatalogDefinedAcpCliCommand.ts'));
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails if runtimeCore-backed routing hides loadRun in a non-command production file', async () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/sample/index.ts',
      content: `
export const sampleBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/command.ts',
      content: `
import { handlePiSessionRouting } from './sessionRouting';

export const command = {
  backendIdForSessionRuntime: 'sample',
  run: handlePiSessionRouting,
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/sessionRouting.ts',
      content: `
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

export async function handlePiSessionRouting(context: unknown) {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => ({ runSample: async () => null }),
  });
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('sessionRouting.ts'));
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails if a runtimeCore-backed helper returns loadRun through indirection', () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/sample/index.ts',
      content: `
export const sampleBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/command.ts',
      content: `
import { createPiSessionCommandOptions } from './sessionRouting';

export async function runPiCli(context: unknown) {
  return runBackendSessionCliCommand(createPiSessionCommandOptions(context));
}
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/sessionRouting.ts',
      content: `
export function createPiSessionCommandOptions(context: unknown) {
  return {
    context,
    loadRun: async () => ({ runSample: async () => null }),
  };
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /helper-indirected loadRun routing/i);
  assert.match(result.errors.join('\n'), /sessionRouting\.ts/);
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails on object-shorthand loadRun at the callsite', () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/sample/index.ts',
      content: `
export const sampleBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/command.ts',
      content: `
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

export async function runPiCli(context: unknown) {
  const loadRun = async () => ({ runSample: async () => null });
  return runBackendSessionCliCommand({ context, loadRun });
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /loadRun/i);
  assert.match(result.errors.join('\n'), /command\.ts/);
});

test('enforceRuntimeCoreSessionCommandRoutingNoLoadRun fails on helper shorthand objects that return loadRun without a colon form', () => {
  const result = enforceRuntimeCoreSessionCommandRoutingNoLoadRun([
    {
      filePath: 'apps/cli/src/backends/sample/index.ts',
      content: `
export const sampleBackend = {
  getRuntimeCore: () => ({ createSessionRuntime: () => null }),
};
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/command.ts',
      content: `
import { createPiSessionCommandOptions } from './sessionRouting';

export async function runPiCli(context: unknown) {
  return runBackendSessionCliCommand(createPiSessionCommandOptions(context));
}
`,
    },
    {
      filePath: 'apps/cli/src/backends/sample/cli/sessionRouting.ts',
      content: `
export function createPiSessionCommandOptions(context: unknown) {
  const loadRun = async () => ({ runSample: async () => null });
  return { context, loadRun };
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /helper-indirected loadRun routing/i);
  assert.match(result.errors.join('\n'), /sessionRouting\.ts/);
});

test('enforceSharedRuntimeForLoopCompatibilityRetirement fails when the shared runtime seam still uses RuntimeForLoopCompatibility adapters', () => {
  const result = enforceSharedRuntimeForLoopCompatibilityRetirement([
    {
      filePath: 'apps/cli/src/agent/runtime/turns/runtimeTurnOperations.ts',
      content: `
export type RuntimeForLoopCompatibility = Readonly<{ beginTurn(): void }>;
export function createRuntimeTurnOperationsFromRuntimeForLoop(runtime: RuntimeForLoopCompatibility) {
  return runtime;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
      content: `
import {
  createRuntimeTurnOperationsFromRuntimeForLoop,
  type RuntimeForLoopCompatibility,
} from '@/agent/runtime/turns/runtimeTurnOperations';

export function normalize(runtime: RuntimeForLoopCompatibility) {
  return createRuntimeTurnOperationsFromRuntimeForLoop(runtime);
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('RuntimeForLoopCompatibility'));
  assert.ok(result.errors.join('\n').includes('sessionLoop/runHostSessionRuntime.ts'));
});

test('enforceSharedRuntimeForLoopCompatibilityRetirement ignores test-only and design-packet references', () => {
  const result = enforceSharedRuntimeForLoopCompatibilityRetirement([
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/executionRun/executionRunUnifiedInterfaceDesignPacket.ts',
      content: 'type RuntimeForLoopOperation = keyof RuntimeForLoopCompatibility;',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/turns/runtimeTurnOperations.test.ts',
      content: 'const runtime = createRuntimeTurnOperationsFromRuntimeForLoop(fakeRuntime);',
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceSharedSessionCanonicalPlanBoundary fails when the bridge contract blesses raw runtime turn operations', () => {
  const result = enforceSharedSessionCanonicalPlanBoundary([
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts',
      content: `
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

export interface SessionHostBridgeContract {
  createSessionRuntime(backendId: string, params: unknown): Promise<RuntimeTurnOperations>;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts',
      content: `
export class SessionHostBridge {
  async createSessionRuntime() {
    return { kind: 'hostSessionRuntimePlan' };
  }
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
      content: 'export type HostSessionRuntimeConfig = { createSessionRuntime?: () => unknown };',
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('sessionBridgeContract.ts'));
});

test('enforceSharedSessionCanonicalPlanBoundary fails when SessionHostBridge widens the canonical runtime helper to raw runtime turn operations', () => {
  const result = enforceSharedSessionCanonicalPlanBoundary([
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts',
      content: `
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export interface SessionHostBridgeContract {
  createSessionRuntime(backendId: string, params: unknown): Promise<HostSessionRuntimePlan>;
  runSessionCommand(backendId: string, params: unknown): Promise<void>;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts',
      content: `
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

export class SessionHostBridge {
  private requireCanonicalSessionRuntime(runtime: HostSessionRuntimePlan | RuntimeTurnOperations) {
    return runtime;
  }
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
      content: 'export type HostSessionRuntimeConfig = { createSessionRuntime?: () => unknown };',
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('SessionHostBridge must not bless raw RuntimeTurnOperations'));
});

test('enforceSharedSessionCanonicalPlanBoundary fails when shared host/session files leak ACP retirement vocabulary', () => {
  const result = enforceSharedSessionCanonicalPlanBoundary([
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts',
      content: `
export interface SessionHostBridgeContract {
  createSessionRuntime(backendId: string, params: unknown): Promise<{ kind: 'hostSessionRuntimePlan' }>;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts',
      content: `
export class SessionHostBridge {
  async createSessionRuntime() {
    return { kind: 'hostSessionRuntimePlan' };
  }
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
      content: 'export type HostSessionRuntimeConfig = { createSessionRuntime?: { legacyRuntimeCore: unknown } };',
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('shared host/session runtime owners must stay neutral'));
});

test('enforceSharedSessionCanonicalPlanBoundary accepts the neutral host-session seam', () => {
  const result = enforceSharedSessionCanonicalPlanBoundary([
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts',
      content: `
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export interface SessionHostBridgeContract {
  createSessionRuntime(backendId: string, params: unknown): Promise<HostSessionRuntimePlan>;
  runSessionCommand(backendId: string, params: unknown): Promise<void>;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts',
      content: `
import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export class SessionHostBridge {
  async createSessionRuntime() {
    return { kind: 'hostSessionRuntimePlan' };
  }

  async runSessionCommand() {
    await runHostSessionRuntimePlan(await this.createSessionRuntime());
  }
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
      content: 'export type HostSessionRuntimeConfig = { createSessionRuntime?: () => unknown };',
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceSharedSessionCanonicalPlanBoundary accepts the live multi-line runSessionCommand signature that carries a nested lifecycle callback', () => {
  const result = enforceSharedSessionCanonicalPlanBoundary([
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/sessionBridgeContract.ts',
      content: `
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

export interface SessionHostBridgeContract {
  createSessionRuntime(backendId: string, params: unknown): Promise<HostSessionRuntimePlan>;
  runSessionCommand(
    backendId: string,
    params: unknown,
    lifecycle?: Readonly<{
      beforeRuntimePlanCommit?: () => void | Promise<void>;
    }>,
  ): Promise<void>;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.ts',
      content: `
import { runHostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

export class SessionHostBridge {
  async createSessionRuntime() {
    return { kind: 'hostSessionRuntimePlan' };
  }

  async runSessionCommand() {
    await runHostSessionRuntimePlan(await this.createSessionRuntime());
  }
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts',
      content: 'export type HostSessionRuntimeConfig = { createSessionRuntime?: () => unknown };',
    },
  ]);

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('enforceAcpSharedSessionCompatibilityAllowlist fails when a new ACP helper imports shared host-session scaffolding', () => {
  const result = enforceAcpSharedSessionCompatibilityAllowlist([
    {
      filePath: 'apps/cli/src/agent/acp/catalog/createCatalogAcpSessionRuntimePlan.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';

export const createCatalogAcpSessionRuntimePlan = createCatalogHostSessionRuntimePlan;
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('createCatalogAcpSessionRuntimePlan.ts'));
});

test('enforceAcpSharedSessionCompatibilityAllowlist accepts the current ACP-owned compatibility allowlist', () => {
  const result = enforceAcpSharedSessionCompatibilityAllowlist([
    {
      filePath: 'apps/cli/src/agent/acp/catalog/builtIn/sessionPlan.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';

export function createBuiltInSessionPlan(opts: unknown) {
  return createCatalogHostSessionRuntimePlan({ opts } as never);
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/builtIn/run.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';
import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export async function runBuiltInAgent(opts: unknown) {
  await runHostSessionRuntimePlan(createCatalogHostSessionRuntimePlan({ opts } as never));
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/configured/sessionPlan.ts',
      content: `
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';

export async function createConfiguredSessionPlan(opts: HostSessionRuntimeRunOptions) {
  return createCatalogHostSessionRuntimePlan({ opts } as never);
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/configured/runConfiguredAcpBackend.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/createCatalogHostSessionRuntimePlan';
import { runHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export async function runConfiguredAcpBackend(opts: unknown) {
  await runHostSessionRuntimePlan(createCatalogHostSessionRuntimePlan({ opts } as never));
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/catalog/configured/startupOverrides.ts',
      content: `
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';

export function resolveConfiguredStartupOverrides(
  opts: HostSessionRuntimeRunOptions,
) {
  return opts;
}
`,
    },
    {
      filePath: 'apps/cli/src/agent/acp/runtime/definition/runtimeCore.ts',
      content: `
import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/catalogPlan';

export function createAcpRuntimeCore(opts: unknown) {
  return createCatalogHostSessionRuntimePlan({ opts } as never);
}
`,
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceAcpSharedSessionCompatibilityAllowlist ignores the neutral catalog runtimeCore binding helper outside ACP ownership', () => {
  const result = enforceAcpSharedSessionCompatibilityAllowlist([
    {
      filePath: 'apps/cli/src/agent/runtime/registry/createCatalogHostRuntimeCoreBinding.ts',
      content: `
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

export type CatalogHostRuntimeCoreBindingConfig = {
  createHostSessionRuntimePlan: (sessionParams: unknown) => Promise<HostSessionRuntimePlan> | HostSessionRuntimePlan;
};
`,
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceSharedSessionRetirementSurfaceAllowlist fails when retirement compatibility symbols regrow in production files', () => {
  const result = enforceSharedSessionRetirementSurfaceAllowlist([
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
      content: 'export type HostSessionRuntimeConfig = { retirement?: HostSessionRuntimeRetirement };',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/hostSessionRuntimeRetirement.ts',
      content: 'export type HostSessionRuntimeRetirement = { createSessionRuntime: () => unknown };',
    },
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/sneakyRetirement.ts',
      content: `
import { createRetiredHostSessionRuntime } from '@/agent/runtime/sessionLoop/hostSessionRuntimeRetirement';

export async function sneakyRetirement() {
  return await createRetiredHostSessionRuntime({ createSessionRuntime: async () => ({}) }, {} as never);
}
`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('sneakyRetirement.ts'));
});

test('enforceSharedSessionRetirementSurfaceAllowlist accepts when no retirement compatibility symbols remain', () => {
  const result = enforceSharedSessionRetirementSurfaceAllowlist([
    {
      filePath: 'apps/cli/src/agent/runtime/sessionLoop/runHostSessionRuntime.ts',
      content: `
export type HostSessionRuntimeConfig = {
  createSessionRuntime?: () => Promise<unknown>;
};

export async function runHostSessionRuntime() {
  return await Promise.resolve();
}
`,
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceRetiredRuntimeAdapterAliasAbsence fails when a retired alias file remains', () => {
  const result = enforceRetiredRuntimeAdapterAliasAbsence([
    {
      filePath: `apps/cli/src/agent/core/${legacyBackendAliasName}.ts`,
      content: '',
    },
    {
      filePath: `apps/cli/src/agent/core/${legacyFactoryAliasName}.ts`,
      content: '',
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('retired runtime adapter alias files still exist'));
});

test('enforceRetiredRuntimeAdapterAliasAbsence fails when a retired alias token remains in source', () => {
  const result = enforceRetiredRuntimeAdapterAliasAbsence([
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/example.ts',
      content: `type RetiredLoop = ${legacyRuntimeLoopAliasName};`,
    },
    {
      filePath: 'apps/cli/src/agent/runtime/session/loop/example.test.ts',
      content: `type RetiredBackend = ${legacyBackendAliasName};`,
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('retired runtime adapter alias tokens still exist'));
});

test('enforceExecutionRunIntentProfileOwnerFence fails when execution-run intent branching escapes the allowlist', () => {
  const result = enforceExecutionRunIntentProfileOwnerFence([
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/executionRunApplyAction.ts',
      content: "if (run.intent === 'voice_agent') return 'allowed';",
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/runtime/rogueExecutionIntentOwner.ts',
      content: "if (run.intent === 'voice_agent') return 'rogue';",
    },
  ]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('rogueExecutionIntentOwner.ts'));
});

test('enforceExecutionRunIntentProfileOwnerFence accepts the current execution-run intent owner files', () => {
  const result = enforceExecutionRunIntentProfileOwnerFence([
    {
      filePath: 'apps/cli/src/agent/executionRuns/profiles/voiceAgent/VoiceAgentProfile.ts',
      content: "export const VoiceAgentProfile = { id: 'voice_agent' };",
    },
    {
      filePath: 'apps/cli/src/agent/executionRuns/policy/intentPolicyRegistry.ts',
      content: "const requiredFeatureId = intent === 'voice_agent' ? 'voice' : undefined;",
    },
    {
      filePath: 'apps/cli/src/session/services/executionRunStartDefaults.ts',
      content: "if (intent === 'voice_agent') return 'streaming';",
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceExecutionRunIntentProfileOwnerFence ignores provider-local non-execution-run intent strings outside the execution-run scope', () => {
  const result = enforceExecutionRunIntentProfileOwnerFence([
    {
      filePath: 'apps/cli/src/backends/opencode/permission/openCodePermissionPolicy.ts',
      content: "if (intent === 'plan') return 'read-only';",
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceExecutionRunIntentProfileOwnerFence accepts the current live source inventory', () => {
  const result = enforceExecutionRunIntentProfileOwnerFence(collectV2ZeroSourceFiles());

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('enforceTrackedV2ZeroReportFreshness fails when checked-in governance report snapshots are stale', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-freshness-'));
  mkdirSync(join(rootDir, '.project/testing/reports/governance'), { recursive: true });
  writeFileSync(join(rootDir, '.project/testing/reports/governance/v2-0-inventory.md'), '# stale\n', 'utf8');
  writeFileSync(join(rootDir, '.project/testing/reports/governance/v2-0-inventory.json'), '{}\n', 'utf8');

  const report: V2ZeroInventoryReport = {
    filesScanned: 1,
    filesMatched: 1,
    totalMatches: 1,
    categories: [
      {
        id: 'builtin-cli-catalog-consumers',
        title: 'Built-in CLI catalog consumers',
        description: 'n/a',
        migrationScaffold: 'n/a',
        count: 1,
        files: ['apps/cli/src/backends/catalog.ts'],
      },
    ],
  };

  const result = enforceTrackedV2ZeroReportFreshness(report, { rootDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join('\n').includes('v2-0-inventory.md'));
});

test('enforceTrackedV2ZeroReportFreshness accepts matching governance report snapshots', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-v2-zero-freshness-ok-'));
  mkdirSync(join(rootDir, '.project/testing/reports/governance'), { recursive: true });

  const report: V2ZeroInventoryReport = {
    filesScanned: 1,
    filesMatched: 1,
    totalMatches: 1,
    categories: [
      {
        id: 'builtin-cli-catalog-consumers',
        title: 'Built-in CLI catalog consumers',
        description: 'n/a',
        migrationScaffold: 'n/a',
        count: 1,
        files: ['apps/cli/src/backends/catalog.ts'],
      },
    ],
  };

  writeFileSync(
    join(rootDir, '.project/testing/reports/governance/v2-0-inventory.md'),
    formatV2ZeroInventoryMarkdown(report),
    'utf8',
  );
  writeFileSync(
    join(rootDir, '.project/testing/reports/governance/v2-0-inventory.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  for (const laneReport of collectV2ZeroLaneExtractReports(report)) {
    const laneBase = join(rootDir, `.project/testing/reports/governance/v2-0-lane-${laneReport.laneId}-extract`);
    writeFileSync(`${laneBase}.md`, formatV2ZeroLaneExtractMarkdown(laneReport), 'utf8');
    writeFileSync(`${laneBase}.json`, `${JSON.stringify(laneReport, null, 2)}\n`, 'utf8');
  }

  const result = enforceTrackedV2ZeroReportFreshness(report, { rootDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
