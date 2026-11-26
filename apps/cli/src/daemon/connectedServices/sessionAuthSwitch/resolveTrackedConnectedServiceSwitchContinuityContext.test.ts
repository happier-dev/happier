import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveTrackedConnectedServiceSwitchContinuityContext } from './resolveTrackedConnectedServiceSwitchContinuityContext';

function resolveTestCandidatePersistedSessionFile(_agentId: string, metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).piSessionFile;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

describe('resolveTrackedConnectedServiceSwitchContinuityContext', () => {
  it('preserves a tracked Pi session file after the resume id is lost', () => {
    const file = '/tmp/previous-pi-session.jsonl';
    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir: '/tmp/connected-services',
      tracked: null,
      persistedSessionMetadata: { piSessionFile: file },
      resolveCandidatePersistedSessionFile: resolveTestCandidatePersistedSessionFile,
    })).toMatchObject({ vendorResumeId: null, candidatePersistedSessionFile: file });
  });

  it('derives materialized root/env and persisted session-file candidate from tracked resume options', () => {
    const baseDir = '/tmp/happier-connected-services';
    const piSessionFile = join(
      baseDir,
      'csm_pi',
      'pi',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-1.jsonl',
    );

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        spawnOptions: {
          directory: '/tmp/project',
          resume: piSessionFile,
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_pi',
            createdAtMs: 1,
          },
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
      resolveCandidatePersistedSessionFile: resolveTestCandidatePersistedSessionFile,
    })).toEqual({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_pi',
        createdAtMs: 1,
      },
      targetMaterializedRoot: join(baseDir, 'csm_pi', 'pi'),
      targetMaterializedEnv: {
        HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: join(baseDir, 'csm_pi', 'pi'),
      },
      vendorResumeId: piSessionFile,
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    });
  });

  it('falls back to durable metadata for identity and provider resume context', () => {
    const baseDir = '/tmp/happier-connected-services';
    const piSessionFile = join(
      baseDir,
      'native',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-from-metadata.jsonl',
    );

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_metadata_pi',
            createdAtMs: 1,
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'pi',
            provider: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              vendorSessionId: 'pi-session-from-metadata',
              sessionFile: piSessionFile,
            },
          },
          piSessionFile,
        },
        spawnOptions: {
          directory: '/tmp/project',
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
      resolveCandidatePersistedSessionFile: resolveTestCandidatePersistedSessionFile,
    })).toEqual({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_metadata_pi',
        createdAtMs: 1,
      },
      targetMaterializedRoot: join(baseDir, 'csm_metadata_pi', 'pi'),
      targetMaterializedEnv: {
        HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: join(baseDir, 'csm_metadata_pi', 'pi'),
      },
      vendorResumeId: piSessionFile,
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    });
  });

  it('uses latest persisted metadata when the live tracked webhook metadata has not received PI resume state yet', () => {
    const baseDir = '/tmp/happier-connected-services';
    const piSessionFile = join(
      baseDir,
      'csm_latest_pi',
      'pi',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-latest.jsonl',
    );

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
        },
        spawnOptions: {
          directory: '/tmp/project',
        },
      },
      persistedSessionMetadata: {
        path: '/tmp/project',
        host: 'host',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy',
        happyLibDir: '/home/user/.happy/lib',
        happyToolsDir: '/home/user/.happy/tools',
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_latest_pi',
          createdAtMs: 1,
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'pi',
          provider: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            vendorSessionId: 'pi-session-latest',
            sessionFile: piSessionFile,
          },
        },
        piSessionFile,
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
      resolveCandidatePersistedSessionFile: resolveTestCandidatePersistedSessionFile,
    })).toEqual({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_latest_pi',
        createdAtMs: 1,
      },
      targetMaterializedRoot: join(baseDir, 'csm_latest_pi', 'pi'),
      targetMaterializedEnv: {
        HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: join(baseDir, 'csm_latest_pi', 'pi'),
      },
      vendorResumeId: piSessionFile,
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    });
  });

  it('prefers latest persisted metadata over stale tracked webhook metadata without overriding explicit tracked resume state', () => {
    const baseDir = '/tmp/happier-connected-services';
    const stalePiSessionFile = join(
      baseDir,
      'csm_stale_pi',
      'pi',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-stale.jsonl',
    );
    const latestPiSessionFile = join(
      baseDir,
      'csm_latest_pi',
      'pi',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-latest.jsonl',
    );

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          piSessionFile: stalePiSessionFile,
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'pi',
            provider: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              vendorSessionId: 'pi-session-stale',
              sessionFile: stalePiSessionFile,
            },
          },
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_stale_pi',
            createdAtMs: 1,
          },
        },
        spawnOptions: {
          directory: '/tmp/project',
        },
      },
      persistedSessionMetadata: {
        path: '/tmp/project',
        host: 'host',
        homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy',
        happyLibDir: '/home/user/.happy/lib',
        happyToolsDir: '/home/user/.happy/tools',
        piSessionFile: latestPiSessionFile,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'pi',
          provider: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            vendorSessionId: 'pi-session-latest',
            sessionFile: latestPiSessionFile,
          },
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_latest_pi',
          createdAtMs: 2,
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
      resolveCandidatePersistedSessionFile: resolveTestCandidatePersistedSessionFile,
    })).toMatchObject({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_latest_pi',
        createdAtMs: 2,
      },
      targetMaterializedRoot: join(baseDir, 'csm_latest_pi', 'pi'),
      vendorResumeId: latestPiSessionFile,
      candidatePersistedSessionFile: latestPiSessionFile,
    });
  });

  it('keeps tracked resume id and persisted-file candidate from the same source before stale metadata', () => {
    const baseDir = '/tmp/happier-connected-services';
    const trackedPiSessionFile = join(
      baseDir,
      'native',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-tracked.jsonl',
    );
    const staleMetadataPiSessionFile = join(
      baseDir,
      'native',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-stale.jsonl',
    );

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_metadata_pi',
            createdAtMs: 1,
          },
          piSessionId: 'pi-session-stale',
          piSessionFile: staleMetadataPiSessionFile,
        },
        spawnOptions: {
          directory: '/tmp/project',
          resume: trackedPiSessionFile,
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
    })).toMatchObject({
      vendorResumeId: trackedPiSessionFile,
      candidatePersistedSessionFile: trackedPiSessionFile,
    });
  });

  it('proves against the freshly materialized selection env/root instead of the pre-switch tracked env (RD-SW-2)', () => {
    // A tracked CONNECTED Claude session switching to another profile: the inherited env points at
    // the OLD member's home. When the switch already rematerialized the target (the selection
    // carries the post-materialization env/root), the continuity proof context must be the NEW home.
    const baseDir = '/tmp/happier-connected-services';
    const oldConfigDir = '/homes/claude-subscription/old-member/claude/claude-config';
    const newConfigDir = '/homes/claude-subscription/new-member/claude/claude-config';

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'claude',
      baseDir,
      tracked: {
        spawnOptions: {
          directory: '/tmp/project',
          resume: 'claude-session-1',
          environmentVariables: {
            HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: oldConfigDir,
            CLAUDE_CONFIG_DIR: oldConfigDir,
          },
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_claude',
            createdAtMs: 1,
          },
        },
      },
      runtimeAuthSelection: {
        profileId: 'new-member',
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: newConfigDir },
        targetMaterializedRoot: newConfigDir,
      },
    })).toMatchObject({
      targetMaterializedRoot: newConfigDir,
      targetMaterializedEnv: {
        HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: newConfigDir,
        CLAUDE_CONFIG_DIR: newConfigDir,
      },
      vendorResumeId: 'claude-session-1',
      cwd: '/tmp/project',
    });
  });
});
