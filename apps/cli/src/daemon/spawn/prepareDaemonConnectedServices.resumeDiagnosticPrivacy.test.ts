import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
  CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
} from '../connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';
import {
  ConnectedServiceMaterializationBlockedError,
} from '../connectedServices/materialize/materializeConnectedServicesForSpawn';
import {
  ConnectedServiceSpawnResumeUnreachableError,
} from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { prepareDaemonConnectedServices } from './prepareDaemonConnectedServices';

const hoisted = vi.hoisted(() => ({
  getActiveAccountSettingsSnapshot: vi.fn(() => null),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  resolveConnectedServiceAuthForSpawn: vi.fn(),
  shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => true),
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: hoisted.getActiveAccountSettingsSnapshot,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: hoisted.loggerDebug,
    warn: hoisted.loggerWarn,
  },
}));

// Preserve the real error class so the catch branch is exercised exactly as it is at runtime;
// the resolver's throw is the fault injected at this logging boundary.
vi.mock('../connectedServices/resolveConnectedServiceAuthForSpawn', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../connectedServices/resolveConnectedServiceAuthForSpawn')
  >();
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: hoisted.resolveConnectedServiceAuthForSpawn,
  };
});

vi.mock('../connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
  shouldResolveConnectedServiceAuthForSpawn: hoisted.shouldResolveConnectedServiceAuthForSpawn,
}));

describe('prepareDaemonConnectedServices resume diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getActiveAccountSettingsSnapshot.mockReturnValue(null);
    hoisted.shouldResolveConnectedServiceAuthForSpawn.mockReturnValue(true);
  });

  it('projects sensitive resume and local-path facts before the daemon logger exports the failure', async () => {
    hoisted.resolveConnectedServiceAuthForSpawn.mockRejectedValueOnce(
      new ConnectedServiceSpawnResumeUnreachableError({
        agentId: 'pi',
        vendorResumeId: 'vendor-session-private-123',
        cwd: '/Users/alice/private-project',
        targetMaterializedRoot: 'C:\\Users\\alice\\.happier\\materialized\\pi',
        reason: 'vendor-session-private-123',
      }),
    );

    const result = await prepareDaemonConnectedServices({
      options: {
        directory: '/Users/alice/private-project',
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
      } as never,
      normalizedExistingSessionId: '',
      requestedSessionId: 'session-1',
      effectiveResume: 'vendor-session-private-123',
      catalogAgentId: 'pi',
      credentials: {} as never,
      api: {} as never,
      connectedServiceRefreshCoordinator: null,
      processEnv: {},
      connectedServicesMaterializationBaseDir: '/tmp/connected-services',
      pluginContributions: {} as never,
    });

    expect(result).toMatchObject({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
    expect(JSON.stringify(result)).not.toContain('vendor-session-private-123');
    expect(JSON.stringify(result)).not.toContain('/Users/alice/private-project');
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\alice\\.happier\\materialized\\pi');
    expect(hoisted.loggerWarn).toHaveBeenCalledWith(
      '[DAEMON RUN] Connected services resume reachability re-verify failed; failing closed before spawn',
      {
        agentId: 'pi',
        errorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        vendorResumeId: CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
        cwd: CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
        targetMaterializedRoot: CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
        reason: 'resume_reachability_unavailable',
      },
    );
  });
  it('bounds plugin-authored materialization diagnostics before the daemon logger and the spawn result export them', async () => {
    // A trusted plugin that wraps an upstream failure is enough: the text is
    // author-authored prose, not a closed classification, and it crosses both
    // the retained daemon log and the structured spawn result.
    hoisted.resolveConnectedServiceAuthForSpawn.mockRejectedValueOnce(
      new ConnectedServiceMaterializationBlockedError([{
        code: 'acme_upstream_rejected',
        providerId: 'codex',
        serviceId: 'openai-codex',
        severity: 'blocking',
        entryName: '/Users/alice/.acme/credentials.json',
        reason: 'upstream refused Authorization: Bearer sk-live-0123456789abcdefghij',
      }]),
    );

    const result = await prepareDaemonConnectedServices({
      options: {
        directory: '/Users/alice/private-project',
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
      } as never,
      normalizedExistingSessionId: '',
      requestedSessionId: 'session-1',
      effectiveResume: '',
      catalogAgentId: 'pi',
      credentials: {} as never,
      api: {} as never,
      connectedServiceRefreshCoordinator: null,
      processEnv: {},
      connectedServicesMaterializationBaseDir: '/tmp/connected-services',
      pluginContributions: {} as never,
    });

    expect(result).toMatchObject({ ok: false, result: { type: 'error' } });
    const exportedResult = JSON.stringify(result);
    const exportedLog = JSON.stringify(hoisted.loggerWarn.mock.calls);
    for (const exported of [exportedResult, exportedLog]) {
      expect(exported).not.toContain('sk-live-0123456789abcdefghij');
      expect(exported).not.toContain('Bearer sk-live');
      expect(exported).not.toContain('/Users/alice/.acme/credentials.json');
    }
    // The closed classification is support evidence and must survive.
    expect(exportedLog).toContain('acme_upstream_rejected');
  });

  it('bounds an unclassified resolution failure before it reaches the spawn result or the debug log', async () => {
    hoisted.resolveConnectedServiceAuthForSpawn.mockRejectedValueOnce(
      new Error('acme upstream failed for /Users/alice/private-project with token sk-live-0123456789abcdefghij'),
    );

    const result = await prepareDaemonConnectedServices({
      options: {
        directory: '/Users/alice/private-project',
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
      } as never,
      normalizedExistingSessionId: '',
      requestedSessionId: 'session-1',
      effectiveResume: '',
      catalogAgentId: 'pi',
      credentials: {} as never,
      api: {} as never,
      connectedServiceRefreshCoordinator: null,
      processEnv: {},
      connectedServicesMaterializationBaseDir: '/tmp/connected-services',
      pluginContributions: {} as never,
    });

    expect(result).toMatchObject({
      ok: false,
      result: { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED' },
    });
    const exported = [JSON.stringify(result), JSON.stringify(hoisted.loggerDebug.mock.calls)];
    for (const value of exported) {
      expect(value).not.toContain('sk-live-0123456789abcdefghij');
      expect(value).not.toContain('/Users/alice/private-project');
    }
  });

  it('projects a post-materialization identity-repair persistence failure before it reaches the daemon logger', async () => {
    const persistAfterMaterialization = vi.fn(async () => {
      throw new Error([
        'client_secret=identity-repair-client-secret-sentinel',
        'https://alice:identity-repair-password-sentinel@example.test/persist?access_token=identity-repair-query-token-sentinel',
        'path=/Users/alice/identity-repair-private-sentinel.json',
      ].join(' '));
    });
    hoisted.resolveConnectedServiceAuthForSpawn.mockResolvedValueOnce(null);

    const result = await prepareDaemonConnectedServices({
      options: {
        directory: '/workspace',
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
      } as never,
      normalizedExistingSessionId: 'session-1',
      requestedSessionId: 'session-1',
      effectiveResume: '',
      catalogAgentId: 'pi',
      credentials: {} as never,
      api: {} as never,
      connectedServiceRefreshCoordinator: null,
      processEnv: {},
      connectedServicesMaterializationBaseDir: '/tmp/connected-services',
      pluginContributions: {} as never,
      repairMissingMaterializationIdentity: async () => ({
        identity: {
          v: 1,
          id: 'csm_identity_repair',
          createdAt: 1,
          source: 'resume_repair',
        },
        persistAfterMaterialization,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'connected_service_materialization_identity_missing',
      },
    });
    expect(persistAfterMaterialization).toHaveBeenCalledOnce();
    const identityRepairLog = hoisted.loggerWarn.mock.calls.find(([message]) =>
      message === '[DAEMON RUN] Failed to persist repaired connected-service materialization identity after exact existing-session materialization',
    );
    expect(identityRepairLog?.[1]).toEqual(expect.objectContaining({ reason: expect.any(String) }));
    const exported = JSON.stringify(identityRepairLog?.[1]);
    for (const sentinel of [
      'identity-repair-client-secret-sentinel',
      'identity-repair-password-sentinel',
      'identity-repair-query-token-sentinel',
      '/Users/alice/identity-repair-private-sentinel.json',
    ]) {
      expect(exported).not.toContain(sentinel);
    }
  });
});
