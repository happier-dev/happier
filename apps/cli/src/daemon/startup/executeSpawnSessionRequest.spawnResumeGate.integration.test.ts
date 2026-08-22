import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';

import type { VendorResumeSupportParams } from '@/agent/catalog/types';
import {
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  isConnectedServiceResumeUnreachableSpawnErrorDetail,
} from '@happier-dev/protocol';

/**
 * §2 (Rule A) gate — end-to-end at dev's spawn seam (`executeSpawnSessionRequest`).
 *
 * This integration test drives the REAL seam and asserts that when the connected-service
 * resume-reachability re-verify fails closed (the daemon throws
 * `ConnectedServiceSpawnResumeUnreachableError` from `resolveConnectedServiceAuthForSpawn`), the
 * seam:
 *   - returns `SPAWN_VALIDATION_FAILED` with the verbatim continuity code+phase in the message
 *     (legacy/copy-based consumers unchanged), AND
 *   - attaches the structured D2 `errorDetail` so clients can recognize "resume unreachable"
 *     programmatically (NOT by parsing the message), AND
 *   - fails closed BEFORE the vendor launches (no spawn / webhook route is taken).
 *
 * The `resolveConnectedServiceAuthForSpawn` module is mocked via `importOriginal` so the real
 * `ConnectedServiceSpawnResumeUnreachableError` class is preserved — the seam's `instanceof`
 * branch must match the same class the test throws.
 */

type MockEnsureSessionDirectoryResult =
  | { ok: true; directoryCreated: boolean }
  | {
      ok: false;
      response: { type: string; errorCode: string; errorMessage: string };
    };

const hoisted = vi.hoisted(() => {
  const vendorResumeSupport = vi.fn((_: VendorResumeSupportParams) => true);
  const resolveSpawnBackendIdentity = vi.fn();
  const getVendorResumeSupport = vi.fn(async () => vendorResumeSupport);
  const requireCatalogEntry = vi.fn();
  const refreshAccountSettingsForMinimumVersion = vi.fn();
  const ensureSessionDirectory = vi.fn<() => Promise<MockEnsureSessionDirectoryResult>>(async () => ({
    ok: true,
    directoryCreated: false,
  }));

  return {
    vendorResumeSupport,
    resolveSpawnBackendIdentity,
    getVendorResumeSupport,
    requireCatalogEntry,
    refreshAccountSettingsForMinimumVersion,
    ensureSessionDirectory,
  };
});

vi.mock('@/session/runtime/catalogHooks', () => ({
  getVendorResumeSupport: hoisted.getVendorResumeSupport,
}));

vi.mock('@/agent/catalog/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/catalog/registry')>();
  return {
    ...actual,
    findCatalogEntry: hoisted.requireCatalogEntry,
    requireCatalogEntry: hoisted.requireCatalogEntry,
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-home',
    activeServerDir: '/tmp/happier-home/servers/active',
  },
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: hoisted.refreshAccountSettingsForMinimumVersion,
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
  validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/session/backendTargets/resolveConcreteBackendTargetRefs', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/session/backendTargets/resolveConcreteBackendTargetRefs')
  >();
  return {
    ...actual,
    resolveConcreteBackendTargetRefV2: vi.fn(),
  };
});

vi.mock('../spawn/resolveSpawnBackendIdentity', () => ({
  resolveSpawnBackendIdentity: hoisted.resolveSpawnBackendIdentity,
}));

vi.mock('../spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: vi.fn(),
}));

vi.mock('../spawn/resolveStackProcessKindOverrideForSessionSpawn', () => ({
  resolveStackProcessKindOverrideForSessionSpawn: vi.fn(),
}));

vi.mock('../spawn/createSpawnLifecycleCallbacks', () => ({
  createSpawnLifecycleCallbacks: vi.fn(),
}));

vi.mock('../spawn/routeSpawnModeAndWaitForWebhook', () => ({
  routeSpawnModeAndWaitForWebhook: vi.fn(),
}));

// Preserve the real ConnectedServiceSpawnResumeUnreachableError class so the seam's
// `instanceof` branch matches the error this test throws; only the resolver is replaced.
vi.mock('../connectedServices/resolveConnectedServiceAuthForSpawn', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../connectedServices/resolveConnectedServiceAuthForSpawn')
  >();
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: vi.fn(),
  };
});

vi.mock('../connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
  shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => false),
}));

vi.mock('./ensureSessionDirectory', () => ({
  ensureSessionDirectory: hoisted.ensureSessionDirectory,
}));

vi.mock('../sessionAttachFile', () => ({
  createSessionAttachFile: vi.fn(),
}));

vi.mock('../processSupervision/sessionRunnerRespawnDescriptor', () => ({
  SessionRunnerRespawnDescriptorV1Schema: z.any(),
  buildTrackedSessionRespawnEnvironmentVariables: vi.fn(),
}));

function createParams() {
  return {
    options: {
      directory: '/tmp/project',
      sessionId: 'session-1',
      resume: 'vendor-session-1',
      backendTarget: { kind: 'backend', backendId: 'pi', sourceKind: 'built_in' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      },
    },
    credentials: {
      token: 'token-1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    },
    api: {} as never,
    loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
    connectedServicesMaterializationBaseDir: '/tmp/connected-services',
    connectedServiceRefreshCoordinator: null,
    connectedServiceQuotasCoordinator: null,
    connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'tracked-session-1'),
    onChildExited: vi.fn(),
    spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(),
    processEnv: {},
  } as const;
}

describe('executeSpawnSessionRequest §2 resume-reachability gate (integration)', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.vendorResumeSupport.mockReset();
    hoisted.resolveSpawnBackendIdentity.mockReset();
    hoisted.getVendorResumeSupport.mockClear();
    hoisted.requireCatalogEntry.mockReset();
    hoisted.refreshAccountSettingsForMinimumVersion.mockReset();
    hoisted.ensureSessionDirectory.mockClear();
    hoisted.getVendorResumeSupport.mockResolvedValue(hoisted.vendorResumeSupport);
    hoisted.vendorResumeSupport.mockReturnValue(true);
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValue({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: 'vendor-session-1',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'pi',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'pi',
    });
    hoisted.refreshAccountSettingsForMinimumVersion.mockResolvedValue(null);
    hoisted.ensureSessionDirectory.mockResolvedValue({ ok: true, directoryCreated: false });
  });

  it('fails closed with SPAWN_VALIDATION_FAILED + structured errorDetail and does not spawn the vendor', async () => {
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveConnectedServiceAuthForSpawn, ConnectedServiceSpawnResumeUnreachableError } = await import(
      '../connectedServices/resolveConnectedServiceAuthForSpawn'
    );
    const { shouldResolveConnectedServiceAuthForSpawn } = await import(
      '../connectedServices/shouldResolveConnectedServiceAuthForSpawn'
    );
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');

    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockRejectedValueOnce(
      new ConnectedServiceSpawnResumeUnreachableError({
        agentId: 'pi',
        vendorResumeId: 'vendor-session-1',
        cwd: '/tmp/project',
        targetMaterializedRoot: '/tmp/materialized/pi-agent-dir',
        reason: 'no_resumable_session_file',
      }),
    );

    const result = await executeSpawnSessionRequest(createParams());

    if (result.type !== 'error') {
      throw new Error(`expected fail-closed error result, got ${result.type}`);
    }
    // Legacy contract preserved: SPAWN_VALIDATION_FAILED + verbatim continuity code/phase in message.
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
    expect(result.errorMessage).toContain('provider_session_state_unavailable_for_resume');
    expect(result.errorMessage).toContain('continuity');

    // D2 structured detail recognized programmatically (not by message parsing).
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected resume-unreachable detail');
    }
    expect(result.errorDetail).toEqual({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'pi',
      reason: 'no_resumable_session_file',
      uxDiagnostic: expect.objectContaining({
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'pi',
        diagnostics: expect.objectContaining({
          reason: 'no_resumable_session_file',
        }),
      }),
    });
    expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
    expect(result.errorDetail).not.toHaveProperty('cwd');
    expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');

    // The gate fired BEFORE the vendor launched: no spawn/webhook route, and the child env was
    // never resolved.
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
    expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
  });

  it('spawns normally when the resume-reachability re-verify succeeds (gate does not over-fire)', async () => {
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveConnectedServiceAuthForSpawn } = await import(
      '../connectedServices/resolveConnectedServiceAuthForSpawn'
    );
    const { shouldResolveConnectedServiceAuthForSpawn } = await import(
      '../connectedServices/shouldResolveConnectedServiceAuthForSpawn'
    );
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { buildTrackedSessionRespawnEnvironmentVariables } = await import(
      '../processSupervision/sessionRunnerRespawnDescriptor'
    );

    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
      qualifiedPurposeBindingSnapshot: null,
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(buildTrackedSessionRespawnEnvironmentVariables).mockReturnValueOnce({});
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    const result = await executeSpawnSessionRequest(createParams());

    expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledTimes(1);
  });
});
