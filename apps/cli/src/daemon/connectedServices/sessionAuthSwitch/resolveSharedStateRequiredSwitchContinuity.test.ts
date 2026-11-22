import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import { resolveSharedStateRequiredSwitchContinuity } from './resolveSharedStateRequiredSwitchContinuity';

describe('resolveSharedStateRequiredSwitchContinuity', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }));
    tempDirs.length = 0;
  });

  it('fails closed for Codex shared-state switches when resume reachability cannot be proven', async () => {
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            stateMode: 'shared',
          },
        },
      },
    });

    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'codex',
      accountSettings,
      warnings: ['codex_shared_state_required'],
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_session_state_unavailable_for_resume',
      warnings: ['codex_shared_state_required', 'codex_session_file_not_found'],
      diagnostics: {
        materializationIdentityId: 'csm_1',
        targetMaterializedRoot: '/tmp/materialized',
        vendorResumeId: 'resume-id',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: null,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        reachabilityMissReason: 'codex_session_file_not_found',
      },
    });
  });

  describe('a session whose provider conversation never started', () => {
    // After a cross-Agent switch whose target failed to start (for example because the target's
    // default account needed reconnecting), the Session is committed to the target Agent but no
    // conversation was ever created under it. There is no resume id and no session file, so there
    // is nothing to prove reachable. Reporting that as "provider session state unavailable" left
    // the owner unable to move the Session to a working account at all.
    const sharedCodexSettings = () => accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'linked', stateMode: 'isolated' },
        byAgentId: { codex: { stateMode: 'shared' } },
      },
    });
    const baseInput = {
      agentId: 'codex' as const,
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1 as const, id: 'csm_1' },
      cwd: '/tmp/project',
    };

    it('lets the switch proceed, because there is no state to carry', async () => {
      await expect(resolveSharedStateRequiredSwitchContinuity({
        ...baseInput,
        accountSettings: sharedCodexSettings(),
        warnings: ['codex_shared_state_required'],
      } as any)).resolves.toEqual({
        mode: 'restart_rematerialize',
        warnings: ['codex_shared_state_required'],
      });
    });

    it('does not need the rest of the target context when there is nothing to carry', async () => {
      await expect(resolveSharedStateRequiredSwitchContinuity({
        agentId: 'codex',
        accountSettings: sharedCodexSettings(),
      } as any)).resolves.toMatchObject({ mode: 'restart_rematerialize' });
    });

    it('still fails closed when a session file is referenced without a resume id', async () => {
      // A referenced session file means a conversation does exist; only its id is unknown, which is
      // exactly the state loss this check exists to refuse to paper over.
      await expect(resolveSharedStateRequiredSwitchContinuity({
        ...baseInput,
        accountSettings: sharedCodexSettings(),
        candidatePersistedSessionFile: '/tmp/project/session.jsonl',
      } as any)).resolves.toMatchObject({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
      });
    });
  });

  it('allows a rematerializing restart when Codex shared-state reachability is proven', async () => {
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            stateMode: 'shared',
          },
        },
      },
    });

    const materializedRoot = await mkdtemp(join(tmpdir(), 'happier-codex-shared-state-'));
    tempDirs.push(materializedRoot);
    const rolloutDir = join(materializedRoot, 'codex-home', 'sessions', '2026', '05', '28');
    const rolloutPath = join(rolloutDir, 'rollout-2026-05-28T00-00-00-resume-id.jsonl');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(rolloutPath, '{}\n');

    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'codex',
      accountSettings,
      warnings: ['codex_shared_state_required'],
      serviceId: 'openai-codex',
      targetMaterializedRoot: materializedRoot,
      targetMaterializedEnv: {
        CODEX_HOME: join(materializedRoot, 'codex-home'),
      },
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'restart_rematerialize',
      warnings: ['codex_shared_state_required'],
      // INC-6: the PROVEN switch must surface what was proven (target root, resume id, state mode)
      // so switch telemetry is not all-null for successful spawn_next_turn/restart switches.
      diagnostics: {
        materializationIdentityId: 'csm_1',
        targetMaterializedRoot: materializedRoot,
        vendorResumeId: 'resume-id',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: null,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
      },
    });
  });

  it('fails closed for PI when shared-state reachability cannot be proven', async () => {
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'isolated',
        },
        byAgentId: {
          pi: {
            stateMode: 'shared',
          },
        },
      },
    });

    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'pi',
      accountSettings,
      warnings: ['pi_session_state_sharing_required'],
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {
        PI_CODING_AGENT_DIR: '/tmp/materialized/pi-agent-dir',
      },
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'pi-session-1',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_session_state_unavailable_for_resume',
      warnings: ['pi_session_state_sharing_required', 'pi_session_file_not_found'],
      diagnostics: {
        materializationIdentityId: 'csm_1',
        targetMaterializedRoot: '/tmp/materialized',
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: null,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        reachabilityMissReason: 'pi_session_file_not_found',
      },
    });
  });

  it('proves an INACTIVE native->connected PI switch reachable from the reconstructed target context (Finding 2 end-to-end)', async () => {
    // Simulates the inactive-switch path: the daemon adapter reconstructs the target materialized
    // root from the materialization identity (no tracked session) and supplies ONLY the root env key
    // (no PI_CODING_AGENT_DIR yet — the import has not run) plus the session cwd. The source-aware
    // (non-strict) reachability probe must still prove the session from the NATIVE ~/.pi root that the
    // next spawn will import from, so a genuinely-resumable inactive session is NOT fail-closed.
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'linked', stateMode: 'isolated' },
        byAgentId: { pi: { stateMode: 'shared' } },
      },
    });

    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-inactive-recon-home-'));
    const reconstructedRoot = await mkdtemp(join(tmpdir(), 'happier-inactive-recon-root-'));
    tempDirs.push(fakeHome, reconstructedRoot);
    const cwd = '/tmp/inactive-native-project';
    const nativeDir = join(fakeHome, '.pi', 'agent', 'sessions', formatPiSessionDirectoryForCwd(cwd));
    await mkdir(nativeDir, { recursive: true });
    await writeFile(join(nativeDir, '2026-05-29T00-00-00-000Z_pi-session-inactive.jsonl'), '{}\n');

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await expect(resolveSharedStateRequiredSwitchContinuity({
        agentId: 'pi',
        accountSettings,
        warnings: ['pi_session_state_sharing_required'],
        serviceId: 'openai-codex',
        // The reconstructed target: deterministic root via the env key, NO PI_CODING_AGENT_DIR yet.
        targetMaterializedRoot: reconstructedRoot,
        targetMaterializedEnv: {
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: reconstructedRoot,
        },
        materializationIdentity: { v: 1, id: 'csm_inactive' },
        vendorResumeId: 'pi-session-inactive',
        cwd,
      } as any)).resolves.toEqual({
        mode: 'restart_rematerialize',
        warnings: ['pi_session_state_sharing_required'],
        diagnostics: {
          materializationIdentityId: 'csm_inactive',
          targetMaterializedRoot: reconstructedRoot,
          vendorResumeId: 'pi-session-inactive',
          cwd,
          candidatePersistedSessionFile: null,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
        },
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('fails closed cleanly for an INACTIVE PI switch when the session is genuinely missing from every source', async () => {
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'linked', stateMode: 'isolated' },
        byAgentId: { pi: { stateMode: 'shared' } },
      },
    });

    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-inactive-miss-home-'));
    const reconstructedRoot = await mkdtemp(join(tmpdir(), 'happier-inactive-miss-root-'));
    tempDirs.push(fakeHome, reconstructedRoot);
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await expect(resolveSharedStateRequiredSwitchContinuity({
        agentId: 'pi',
        accountSettings,
        warnings: ['pi_session_state_sharing_required'],
        serviceId: 'openai-codex',
        targetMaterializedRoot: reconstructedRoot,
        targetMaterializedEnv: {
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: reconstructedRoot,
        },
        materializationIdentity: { v: 1, id: 'csm_inactive_miss' },
        vendorResumeId: 'pi-session-absent',
        cwd: '/tmp/inactive-absent-project',
      } as any)).resolves.toEqual({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
        warnings: ['pi_session_state_sharing_required', 'pi_session_file_not_found'],
        diagnostics: {
          materializationIdentityId: 'csm_inactive_miss',
          targetMaterializedRoot: reconstructedRoot,
          vendorResumeId: 'pi-session-absent',
          cwd: '/tmp/inactive-absent-project',
          candidatePersistedSessionFile: null,
          requestedStateMode: 'isolated',
          effectiveStateMode: 'isolated',
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('keeps the switch unsupported when provider state sharing is isolated', async () => {
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'isolated',
        },
      },
    });

    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'codex',
      accountSettings,
      warnings: ['codex_shared_state_required'],
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_state_sharing_required',
      warnings: ['codex_shared_state_required'],
    });
  });

  it('distinguishes a missing account-settings snapshot from genuinely unavailable sharing (retryable settings_unavailable)', async () => {
    // Incident Jun-11 H-A: a freshly restarted daemon has a NULL in-memory settings snapshot.
    // "Settings unknown" must NOT be reported as "sharing unavailable" (which the recovery
    // scheduler terminalizes as non_retryable_apply_failure) — it is a retryable infrastructure
    // gap that resolves once the snapshot is bootstrapped.
    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'codex',
      accountSettings: null,
      warnings: ['codex_shared_state_required'],
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_state_sharing_settings_unavailable',
      warnings: ['codex_shared_state_required'],
    });
  });

  it('reports provider state sharing as unavailable when the provider cannot share session state', async () => {
    const accountSettings = accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'shared',
        },
      },
    });

    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'opencode',
      accountSettings,
      warnings: ['opencode_shared_state_required'],
      serviceId: 'openai',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_state_sharing_unavailable',
      warnings: ['opencode_shared_state_required'],
    });
  });
});
