import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from './resolveTrackedConnectedServiceSwitchContinuityContext';

describe('resolveTrackedConnectedServiceSwitchContinuityContext', () => {
  it('threads the runtime-auth selection materialized target into the continuity context', () => {
    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'claude',
      baseDir: '/tmp/happier-connected-services',
      tracked: {
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/happier-connected-services/old-home/claude',
            [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: '/tmp/happier-connected-services/old-home/claude',
            EXISTING: '1',
          },
        },
      },
      runtimeAuthSelection: {
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/happier-connected-services/new-home/claude' },
        targetMaterializedRoot: '/tmp/happier-connected-services/new-home/claude',
      },
    })).toMatchObject({
      targetMaterializedRoot: '/tmp/happier-connected-services/new-home/claude',
      targetMaterializedEnv: {
        CLAUDE_CONFIG_DIR: '/tmp/happier-connected-services/new-home/claude',
        EXISTING: '1',
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: '/tmp/happier-connected-services/new-home/claude',
      },
      cwd: '/tmp/project',
    });
  });

  it('derives materialized root/env and persisted session-file candidate from tracked resume options', () => {
    const baseDir = '/tmp/happier-connected-services';
    const piSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-1.jsonl',
    );
    const expectedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'pi',
      materializationKey: 'csm_pi',
    });

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
            createdAt: 1,
            source: 'first_spawn',
          },
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
    })).toEqual({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_pi',
        createdAt: 1,
        source: 'first_spawn',
      },
      targetMaterializedRoot: expectedRoot,
      targetMaterializedEnv: {
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: expectedRoot,
      },
      vendorResumeId: piSessionFile,
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    });
  });

  it('falls back to durable metadata for identity, resume id, and provider-owned persisted file candidate', () => {
    const baseDir = '/tmp/happier-connected-services';
    const piSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-from-metadata.jsonl',
    );
    const expectedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'pi',
      materializationKey: 'csm_pi_metadata',
    });

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        spawnOptions: {
          directory: '',
          backendTarget: { kind: 'backend', backendId: 'pi', sourceKind: 'built_in' },
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              openai: {
                source: 'connected',
                selection: 'profile',
                profileId: 'profile-1',
              },
            },
          },
        },
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          piSessionId: 'pi-session-from-metadata',
          piSessionFile,
          connectedServiceMaterializationIdentityV1: {
            v: 1 as const,
            id: 'csm_pi_metadata',
            createdAt: 2,
            source: 'metadata',
          },
        } as TrackedSession['happySessionMetadataFromLocalWebhook'] & { piSessionFile?: string },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
    })).toEqual({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_pi_metadata',
        createdAt: 2,
        source: 'metadata',
      },
      targetMaterializedRoot: expectedRoot,
      targetMaterializedEnv: {
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: expectedRoot,
      },
      vendorResumeId: 'pi-session-from-metadata',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    });
  });

  it('uses latest persisted metadata when the live tracked webhook metadata has not received PI resume state yet', () => {
    const baseDir = '/tmp/happier-connected-services';
    const piSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-latest.jsonl',
    );
    const expectedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'pi',
      materializationKey: 'csm_latest_pi',
    });

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
        } as TrackedSession['happySessionMetadataFromLocalWebhook'],
        spawnOptions: {
          directory: '/tmp/project',
        },
      },
      persistedSessionMetadata: {
        path: '/tmp/project',
        piSessionId: 'pi-session-latest',
        piSessionFile,
        connectedServiceMaterializationIdentityV1: {
          v: 1 as const,
          id: 'csm_latest_pi',
          createdAt: 1,
          source: 'metadata',
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
    })).toEqual({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_latest_pi',
        createdAt: 1,
        source: 'metadata',
      },
      targetMaterializedRoot: expectedRoot,
      targetMaterializedEnv: {
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: expectedRoot,
      },
      vendorResumeId: 'pi-session-latest',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    });
  });

  it('prefers latest persisted metadata over stale tracked webhook metadata without overriding explicit tracked resume state', () => {
    const baseDir = '/tmp/happier-connected-services';
    const stalePiSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-stale.jsonl',
    );
    const latestPiSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-latest.jsonl',
    );
    const expectedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'pi',
      materializationKey: 'csm_latest_pi',
    });

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
          piSessionId: 'pi-session-stale',
          piSessionFile: stalePiSessionFile,
          connectedServiceMaterializationIdentityV1: {
            v: 1 as const,
            id: 'csm_stale_pi',
            createdAt: 1,
            source: 'metadata',
          },
        } as TrackedSession['happySessionMetadataFromLocalWebhook'] & { piSessionFile?: string },
        spawnOptions: {
          directory: '/tmp/project',
        },
      },
      persistedSessionMetadata: {
        path: '/tmp/project',
        piSessionId: 'pi-session-latest',
        piSessionFile: latestPiSessionFile,
        connectedServiceMaterializationIdentityV1: {
          v: 1 as const,
          id: 'csm_latest_pi',
          createdAt: 2,
          source: 'metadata',
        },
      },
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      cwd: null,
      candidatePersistedSessionFile: null,
    })).toMatchObject({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_latest_pi',
        createdAt: 2,
        source: 'metadata',
      },
      targetMaterializedRoot: expectedRoot,
      vendorResumeId: 'pi-session-latest',
      candidatePersistedSessionFile: latestPiSessionFile,
    });
  });

  it('keeps tracked resume id and persisted-file candidate from the same source before stale metadata', () => {
    const baseDir = '/tmp/happier-connected-services';
    const trackedPiSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-tracked.jsonl',
    );
    const staleMetadataPiSessionFile = join(
      baseDir,
      'source',
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-06-01T00-00-00-000Z_pi-session-stale.jsonl',
    );

    expect(resolveTrackedConnectedServiceSwitchContinuityContext({
      agentId: 'pi',
      baseDir,
      tracked: {
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'pi', sourceKind: 'built_in' },
          resume: trackedPiSessionFile,
        },
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          piSessionId: 'pi-session-stale',
          piSessionFile: staleMetadataPiSessionFile,
          connectedServiceMaterializationIdentityV1: {
            v: 1 as const,
            id: 'csm_pi_metadata',
            createdAt: 2,
            source: 'metadata',
          },
        } as TrackedSession['happySessionMetadataFromLocalWebhook'] & { piSessionFile?: string },
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
});
