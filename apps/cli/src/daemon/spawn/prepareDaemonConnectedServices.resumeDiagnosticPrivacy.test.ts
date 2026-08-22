import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
  CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
} from '../connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';

const hoisted = vi.hoisted(() => ({
  getActiveAccountSettingsSnapshot: vi.fn(() => null),
  loggerWarn: vi.fn(),
  resolveConnectedServiceAuthForSpawn: vi.fn(),
  shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => true),
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: hoisted.getActiveAccountSettingsSnapshot,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
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
    const {
      ConnectedServiceSpawnResumeUnreachableError,
    } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { prepareDaemonConnectedServices } = await import('./prepareDaemonConnectedServices');

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
});
