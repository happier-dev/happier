import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  LocalServicePreviewSnapshotV1,
  RuntimeActionExecute,
  RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import { createLocalServiceInventoryRegistry } from '../../../../apps/cli/src/daemon/local/services/inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../../../../apps/cli/src/daemon/local/services/inventory/scanner';
import {
  createLocalServicePreviewRegistry,
  listLocalServicePreviewResources,
} from '../../../../apps/cli/src/daemon/local/services/preview/registry';
import {
  createLocalServicePreviewRoutes,
  type LocalServicePreviewRoutes,
} from '../../../../apps/cli/src/daemon/local/services/preview/routes';
import { repoRootDir } from '../../src/testkit/paths';

/**
 * Layer coverage for local-services preview lifecycle (LANE-PREVIEW / PPT-1..3 / F2-preview / DUP-6).
 *
 * Private-preview default-ON renders; `openOrCreate`/`revoke` round-trip through the assembled daemon
 * runtime action executor; ONE store (the daemon preview registry) reflects both the lifecycle
 * mutations and the status poll. This drives the REAL assembled daemon preview layer:
 *   inventory registry (detected loopback dev server) → preview registry (the single store) →
 *   `createLocalServicePreviewRoutes` → `createLocalServicesDaemonRuntimeActionExecutor`
 * — the exact modules the daemon execution-run dispatch wires. No internal mocks: the registry,
 * routes, executor and fail-closed feature gate are the production singletons. The only thing not
 * exercised here is the live server+daemon+socket dispatch transport, UI iframe render, and
 * cross-device socket transport; those belong in L6 live QA E2E suites.
 *
 * The runtime-action executor factory is loaded by computed file URL (the established core-e2e
 * pattern for crossing into `apps/cli`) so the tests TS program is not pulled through the `@/`-alias
 * imports in the executor's sibling route modules; the registry/routes/inventory owners we drive
 * directly are statically typed.
 */

const MACHINE_ID = 'machine_preview_e2e';
const INVENTORY_ENTRY_ID = 'entry-vite';
const SESSION_ID = 'session_preview_e2e';

type LocalServicesFeatureGate = Readonly<{
  isEnabled: (featureId: string) => boolean;
  refresh: () => Promise<void>;
}>;

type CreateLocalServicesDaemonRuntimeActionExecutor = (input: Readonly<{
  routes: Readonly<{ previewRoutes: LocalServicePreviewRoutes }>;
  featureGate?: LocalServicesFeatureGate;
}>) => RuntimeActionExecute;

async function loadExecutorFactory(): Promise<CreateLocalServicesDaemonRuntimeActionExecutor> {
  const moduleUrl = pathToFileURL(
    join(repoRootDir(), 'apps/cli/src/daemon/local/services/actions/runtimeActionExecutor.ts'),
  ).href;
  const mod = (await import(moduleUrl)) as {
    createLocalServicesDaemonRuntimeActionExecutor: CreateLocalServicesDaemonRuntimeActionExecutor;
  };
  return mod.createLocalServicesDaemonRuntimeActionExecutor;
}

function viteInventoryEntry(): NormalizedLocalServiceInventoryEntry {
  return {
    id: INVENTORY_ENTRY_ID,
    machineId: MACHINE_ID,
    address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
    port: 5173,
    protocol: 'tcp',
    detectedAt: 1_000,
    lastSeenAt: 2_000,
    state: 'listening',
    source: 'detected',
    labels: [],
    confidence: 'high',
    processOwnershipConfidence: 'high',
    workspaceAssociationConfidence: 'high',
    diagnostics: [],
    presentation: { addressLabel: 'localhost:5173', displayName: 'Vite' },
  };
}

function inventoryRegistryWithVite() {
  const registry = createLocalServiceInventoryRegistry();
  registry.replaceSnapshot({
    v: 1,
    machineId: MACHINE_ID,
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [viteInventoryEntry()],
    diagnostics: [],
  });
  return registry;
}

function gateWith(enabled: Readonly<Record<string, boolean>>): LocalServicesFeatureGate {
  return {
    isEnabled: (id) => enabled[id] === true,
    refresh: async () => {},
  };
}

function runtimeArgs(
  args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
  return { context: {}, ...args } as RuntimeActionExecuteArgs;
}

async function buildAssembledPreviewStack(featureGate?: LocalServicesFeatureGate) {
  // THE single store both the action mutations and the status poll read/write.
  const registry = createLocalServicePreviewRegistry();
  const routes = createLocalServicePreviewRoutes({
    machineId: MACHINE_ID,
    registry,
    inventoryRegistry: inventoryRegistryWithVite(),
    now: () => 1_000,
  });
  const createExecutor = await loadExecutorFactory();
  const executor = createExecutor({
    routes: { previewRoutes: routes },
    ...(featureGate ? { featureGate } : {}),
  });
  return { registry, executor };
}

function previewCount(registry: ReturnType<typeof createLocalServicePreviewRegistry>): number {
  return listLocalServicePreviewResources(registry).length;
}

describe('core layer: local-services preview lifecycle through the assembled daemon executor', () => {
  it('openOrCreate renders a private preview, status polls the same store, and revoke clears it', async () => {
    const { registry, executor } = await buildAssembledPreviewStack(gateWith({ 'localServices.preview': true }));

    // openOrCreate (UI→daemon RPC) — private preview default-ON renders the real loopback embed.
    const created = await executor(runtimeArgs({
      actionId: 'localServices.preview.openOrCreate',
      input: { machineId: MACHINE_ID, sessionId: SESSION_ID, targetId: INVENTORY_ENTRY_ID },
    })) as Readonly<{ status: string; preview: { accessUrl: string; resource: { browserTarget?: { kind: string } } }; snapshot: LocalServicePreviewSnapshotV1 }>;

    expect(created.status).toBe('created');
    // "private-ON renders": the row carries the minted private loopback accessUrl + a renderable
    // localServicePreview browser target.
    expect(created.preview.accessUrl).toBe('http://127.0.0.1:5173/');
    expect(created.preview.resource.browserTarget?.kind).toBe('localServicePreview');
    expect(created.snapshot.previews ?? []).toHaveLength(1);
    // ONE store reflects the create.
    expect(previewCount(registry)).toBe(1);
    const previewId = listLocalServicePreviewResources(registry)[0]?.previewId;
    expect(typeof previewId).toBe('string');

    // status (poll) reads the SAME store and reflects the created preview.
    const status = await executor(runtimeArgs({
      actionId: 'localServices.preview.status',
      input: { machineId: MACHINE_ID },
    })) as LocalServicePreviewSnapshotV1;
    expect(status.previews ?? []).toHaveLength(1);
    expect((status.previews ?? [])[0]?.accessUrl).toBe('http://127.0.0.1:5173/');

    // openOrCreate is idempotent against the one store: a second call returns the existing preview.
    const again = await executor(runtimeArgs({
      actionId: 'localServices.preview.openOrCreate',
      input: { machineId: MACHINE_ID, sessionId: SESSION_ID, targetId: INVENTORY_ENTRY_ID },
    })) as Readonly<{ status: string; snapshot: LocalServicePreviewSnapshotV1 }>;
    expect(again.status).toBe('existing');
    expect(again.snapshot.previews ?? []).toHaveLength(1);
    expect(previewCount(registry)).toBe(1);

    // revoke (UI→daemon RPC) — the SAME store reflects the removal.
    const revoked = await executor(runtimeArgs({
      actionId: 'localServices.preview.revoke',
      input: { machineId: MACHINE_ID, previewId },
    })) as Readonly<{ revoked: boolean; snapshot: LocalServicePreviewSnapshotV1 }>;
    expect(revoked.revoked).toBe(true);
    expect(revoked.snapshot.previews ?? []).toHaveLength(0);
    expect(previewCount(registry)).toBe(0);

    // A status poll after revoke confirms the one store is empty (no stale render row).
    const statusAfter = await executor(runtimeArgs({
      actionId: 'localServices.preview.status',
      input: { machineId: MACHINE_ID },
    })) as LocalServicePreviewSnapshotV1;
    expect(statusAfter.previews ?? []).toHaveLength(0);
  });

  it('fails closed at the daemon when the localServices.preview feature is disabled', async () => {
    const { registry, executor } = await buildAssembledPreviewStack(gateWith({ 'localServices.preview': false }));

    const result = await executor(runtimeArgs({
      actionId: 'localServices.preview.openOrCreate',
      input: { machineId: MACHINE_ID, sessionId: SESSION_ID, targetId: INVENTORY_ENTRY_ID },
    })) as Readonly<{ ok?: boolean; errorCode?: string }>;

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('runtime_action_disabled');
    // The store was never mutated by a gated call.
    expect(previewCount(registry)).toBe(0);
  });
});
