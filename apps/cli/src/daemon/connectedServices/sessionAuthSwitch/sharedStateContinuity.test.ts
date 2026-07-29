import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { resolveSharedStateRequiredSwitchContinuity } from './sharedStateContinuity';

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
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
      warnings: ['codex_shared_state_required'],
    } as any)).resolves.toMatchObject({
      mode: 'unsupported',
      errorCode: 'provider_session_state_unavailable_for_resume',
      warnings: ['codex_shared_state_required', 'codex_session_file_not_found'],
      diagnostics: {
        materializationIdentityId: 'csm_1',
        targetMaterializedRoot: '/tmp/materialized',
        vendorResumeId: 'resume-id',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: null,
        reachabilityMissReason: 'codex_session_file_not_found',
      },
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
    const rolloutDir = join(materializedRoot, 'sessions', '2026', '05', '28');
    const rolloutPath = join(rolloutDir, 'rollout-2026-05-28-resume-id.jsonl');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(rolloutPath, '{}\n');

    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'codex',
      accountSettings,
      warnings: ['codex_shared_state_required'],
      serviceId: 'openai-codex',
      targetMaterializedRoot: materializedRoot,
      targetMaterializedEnv: {
        CODEX_HOME: materializedRoot,
      },
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
    } as any)).resolves.toEqual({
      mode: 'restart_rematerialize',
      warnings: ['codex_shared_state_required'],
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
    } as any)).resolves.toMatchObject({
      mode: 'unsupported',
      errorCode: 'provider_session_state_unavailable_for_resume',
      warnings: ['pi_session_state_sharing_required', 'pi_session_file_not_found'],
      diagnostics: {
        materializationIdentityId: 'csm_1',
        targetMaterializedRoot: '/tmp/materialized',
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: null,
        reachabilityMissReason: 'pi_session_file_not_found',
      },
    });
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
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
      warnings: ['codex_shared_state_required'],
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_state_sharing_required',
      warnings: ['codex_shared_state_required'],
    });
  });

  it('reports a RETRYABLE settings-unavailable outcome (not generic sharing-unavailable) when account settings are not loaded', async () => {
    // Incident Jun-11 H-A: a missing in-memory account-settings snapshot (freshly
    // restarted daemon) is an infrastructure gap, not proof that sharing is
    // unsupported — it must surface a distinct, retryable error code.
    await expect(resolveSharedStateRequiredSwitchContinuity({
      agentId: 'codex',
      accountSettings: null,
      serviceId: 'openai-codex',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
      warnings: ['codex_shared_state_required'],
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
      serviceId: 'openai',
      targetMaterializedRoot: '/tmp/materialized',
      targetMaterializedEnv: {},
      materializationIdentity: { v: 1, id: 'csm_1' },
      vendorResumeId: 'resume-id',
      cwd: '/tmp/project',
      warnings: ['opencode_shared_state_required'],
    } as any)).resolves.toEqual({
      mode: 'unsupported',
      errorCode: 'provider_state_sharing_unavailable',
      warnings: ['opencode_shared_state_required'],
    });
  });
});
