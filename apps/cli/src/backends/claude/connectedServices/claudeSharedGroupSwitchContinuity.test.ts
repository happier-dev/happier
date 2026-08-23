import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConnectedServiceAuthGroupPolicyV1Schema,
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { createSessionConnectedServiceAuthHotApply } from '@/daemon/connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import {
  switchSessionConnectedServiceAuth,
  type SwitchSessionConnectedServiceAuthInput,
} from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import type { Credentials } from '@/persistence';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from './createClaudeConnectedServiceRuntimeAuthAdapter';
import { materializeClaudeConnectedServiceRuntimeAuthSelection } from './materializeClaudeConnectedServiceRuntimeAuthSelection';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { resolveClaudeConnectedServiceSwitchContinuity } from './resolveClaudeConnectedServiceSwitchContinuity';

// Genuine server transport boundary: the provider materializer may consult persisted session
// metadata when tracked continuity metadata is incomplete. This composition test keeps that
// boundary offline while exercising the real materializer, continuity owner, switch FSM, and
// provider hot-apply adapter.
const mockFetchSessionByIdCompat = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mockFetchSessionByIdCompat,
}));

const NEW_CREDENTIAL_REVISION = 'csr_bcdefghijklmnopqrstuvw';

function groupBindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'claude-subscription': {
        source: 'connected',
        selection: 'group',
        groupId: 'work',
        profileId,
      },
    },
  };
}

describe('Claude shared-group switch continuity', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    }
  });

  afterEach(async () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    await Promise.all(temporaryDirectories.splice(0).map(
      async (directory) => await rm(directory, { recursive: true, force: true }),
    ));
  });

  it('hot-applies an exact same-group shared-home rewrite when spawn request env predates materialization', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-continuity-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-continuity-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-continuity-project-'));
    temporaryDirectories.push(activeServerDir, homeDir, projectDir);

    const selectedRecord = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'lb_bat',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'lb-bat-selected-access',
        refreshToken: 'lb-bat-selected-refresh',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'lb-bat-provider-account',
        providerEmail: 'lb-bat@example.test',
      },
    });
    const groupClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'lb_bat',
      selection: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'work',
        activeProfileId: 'lb_bat',
        fallbackProfileId: 'leeroy',
        generation: 272,
        record: selectedRecord,
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
      },
    });
    if (!groupClaudeConfigDir) throw new Error('expected deterministic Claude shared group home');

    const previousBindings = groupBindings('leeroy');
    const nextBindings = groupBindings('lb_bat');
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'claude-session',
      pid: 38562,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        // Real daemon composition stores the request-time env here. Connected Services adds the
        // finalized shared-home env later, so this snapshot is legitimately empty.
        environmentVariables: {},
      },
    };
    const credentials = {
      token: 'account-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    } satisfies Credentials;
    const api = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceCredentialPlain: async () => ({
        content: { t: 'plain' as const, v: selectedRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: NEW_CREDENTIAL_REVISION,
      }),
      getConnectedServiceCredentialSealed: async () => null,
      listConnectedServiceProfiles: async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [{ profileId: 'lb_bat', status: 'connected' as const }],
      }),
      getConnectedServiceAuthGroup: async () => ({
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'work',
        displayName: 'Work',
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
        activeProfileId: 'lb_bat',
        generation: 272,
        runtimeStateRevision: 0,
        state: { v: 1 as const },
        members: [
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'work',
            profileId: 'leeroy',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'work',
            profileId: 'lb_bat',
            priority: 90,
            enabled: true,
            state: {},
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      }),
    };
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const validateGroupMutationCurrentness = vi.fn(createConnectedServiceGroupMutationCurrentnessValidator({
      api: api as unknown as ApiClient,
      credentials,
    }));

    const result = await switchSessionConnectedServiceAuth({
      core: createConnectedServiceSessionAuthSwitchCore({
        locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
      }),
      switchReason: 'automatic_runtime_failure',
      postSwitchVerificationMode: {
        kind: 'disabled_for_test_only',
        reason: 'this gate exercises exact application and continuity, not later provider activity',
      },
      getChildren: () => [tracked],
      api,
      expectedCredentialRevisionByServiceId: {
        'claude-subscription': NEW_CREDENTIAL_REVISION,
      },
      materializeRuntimeAuthSelection: async (input) => {
        const binding = input.normalizedBindings.bindingsByServiceId['claude-subscription'];
        if (!binding || binding.source !== 'connected' || binding.selection !== 'group') {
          throw new Error('expected selected Claude subscription group binding');
        }
        const baseSelection = {
          serviceId: 'claude-subscription' as const,
          binding,
          profileId: 'lb_bat',
          groupId: 'work',
          activeProfileId: 'lb_bat',
          fallbackProfileId: 'leeroy',
          generation: 272,
          credentialRevision: NEW_CREDENTIAL_REVISION,
          record: selectedRecord,
        };
        return await materializeClaudeConnectedServiceRuntimeAuthSelection({
          credentials,
          api: api as unknown as ApiClient,
          activeServerDir,
          input,
          baseSelection,
          processEnv: {
            HOME: homeDir,
            CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
          },
        });
      },
      resolveContinuity: async (input) => {
        const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
          agentId: input.agentId,
          baseDir: activeServerDir,
          tracked: input.tracked,
          connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1,
          vendorResumeId: input.vendorResumeId,
          runtimeAuthSelection: input.runtimeAuthSelection,
        });
        const continuity = await resolveClaudeConnectedServiceSwitchContinuity({
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceId: input.serviceId,
          previousBinding: input.previous,
          nextBinding: input.next,
          fromBindings: input.previousBindings,
          toBindings: input.normalizedBindings,
          runtimeAuthSelection: input.runtimeAuthSelection,
          connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
          vendorResumeId: continuityContext.vendorResumeId,
          targetMaterializedRoot: continuityContext.targetMaterializedRoot,
          targetMaterializedEnv: continuityContext.targetMaterializedEnv,
          cwd: continuityContext.cwd,
          candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
        });
        if (continuity.mode === 'hot_apply') return { mode: 'hot_apply' };
        throw new Error(`Expected hot_apply continuity, got ${continuity.mode}`);
      },
      restartSession,
      hotApply: createSessionConnectedServiceAuthHotApply({
        resolveRuntimeAuthAdapter: async () => createClaudeConnectedServiceRuntimeAuthAdapter(),
        validateGroupMutationCurrentness,
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'claude-session',
        agentId: 'claude',
        bindings: nextBindings,
        expectedGroupGenerationByServiceId: {
          'claude-subscription': 272,
        },
      },
    } satisfies SwitchSessionConnectedServiceAuthInput);

    expect(result).toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: {
        'claude-subscription': 'hot_apply',
      },
    });
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).toHaveBeenCalledOnce();
    expect(validateGroupMutationCurrentness).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      groupId: 'work',
      profileId: 'lb_bat',
      generation: 272,
      credentialRevision: NEW_CREDENTIAL_REVISION,
    });

    const registeredSelections = registerHotApplyTargets.mock.calls[0]?.[1]
      ?.runtimeAuthSelectionsByServiceId as ReadonlyMap<string, unknown> | undefined;
    expect(registeredSelections?.get('claude-subscription')).toMatchObject({
      serviceId: 'claude-subscription',
      groupId: 'work',
      activeProfileId: 'lb_bat',
      generation: 272,
      credentialRevision: NEW_CREDENTIAL_REVISION,
      targetMaterializedRoot: groupClaudeConfigDir,
      targetMaterializedEnv: {
        CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
      },
      claudeRuntimeAuthSharedGroupSurface: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir: groupClaudeConfigDir,
        runtimeMaterializedRoot: groupClaudeConfigDir,
      },
    });
    const materializedCredentials = JSON.parse(
      await readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'),
    ) as { claudeAiOauth?: { accessToken?: string } };
    expect(materializedCredentials.claudeAiOauth?.accessToken).toBe('lb-bat-selected-access');
    expect(JSON.parse(await readFile(join(groupClaudeConfigDir, '.claude.json'), 'utf8'))).toMatchObject({
      hasCompletedOnboarding: true,
    });
  });
});
