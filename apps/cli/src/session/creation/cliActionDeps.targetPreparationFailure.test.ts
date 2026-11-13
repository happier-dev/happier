import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, deriveSessionCreationTagV1 } from '@happier-dev/protocol';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

// HTTP is the system boundary; Machine RPC and creation projection stay real.
const httpGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { defaults: {}, get: httpGet } }));

describe('session creation target preparation transport failures', () => {
  it.each([
    {
      label: 'machine RPC timeout',
      error: () => Object.assign(new Error('private timeout'), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE }),
      code: MACHINE_RPC_TIMEOUT_ERROR_CODE,
    },
    {
      label: 'transport unavailable',
      error: () => Object.assign(new Error('private transport detail'), { rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }),
      code: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    },
    {
      label: 'HTTP failure without an RPC code',
      error: () => Object.assign(new Error('private HTTP response'), { response: { status: 503, data: 'private body' } }),
      code: 'SPAWN_FAILED',
    },
    {
      label: 'target refusal',
      error: () => Object.assign(new Error('private refusal detail'), { rpcErrorCode: 'target_unavailable' }),
      code: 'target_unavailable',
    },
  ])('preserves the typed $label cause through the real creation preflight', async ({ error, code }) => {
    httpGet.mockReset().mockRejectedValue(error());
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'target-preparation-test' })).toString('base64url')}.signature`;
    const params = {
      token,
      credentials: { token, encryption: null },
      sessionId: 'target-preparation-session',
      serverId: 'target-preparation-home',
      serverIdentityId: 'target-preparation-home',
      mode: 'plain' as const,
      ctx: null,
      serverHttpBaseUrl: 'https://target-preparation.test',
      actionsSettingsProvider: createActionSettingsProvider({
        accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }),
      }),
    } satisfies Parameters<typeof createCliActionDeps>[0];

    const deps = createCliActionDeps(params);
    const result = await deps.sessionSpawnNewDirectoryApprovalPreflight!({
      input: SessionSpawnNewInputV2Schema.parse({
        creationKey: 'target-preparation-failure',
        executionTarget: { serverId: 'target-preparation-home', machineId: 'target-preparation-machine' },
        directory: { kind: 'path', path: '/target-preparation/project' },
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} },
      }),
    });

    expect(result).toMatchObject({
      type: 'error',
      result: {
        type: 'error',
        code: 'spawn_failed',
        launchError: {
          kind: 'launch_error',
          code,
          ...(code === 'target_unavailable' || code === 'SPAWN_FAILED' ? {} : { rpcErrorCode: code }),
        },
      },
    });
    if (code === 'SPAWN_FAILED') {
      expect(result).toMatchObject({ result: { failureCause: { phase: 'session.target_preparation',
        errorClass: 'Error', errorCode: null, httpStatus: 503 } } });
      expect(SessionSpawnNewResultV1Schema.parse('result' in result ? result.result : result)).toMatchObject({
        failureCause: { phase: 'session.target_preparation', httpStatus: 503 },
      });
    }
    expect(JSON.stringify(result)).not.toContain('private');
  });
});


it('keeps a typed catalog cause when the selected Agent contribution is absent', async () => {
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'missing-agent-test' })).toString('base64url')}.signature`;
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '',
    serverId: 'missing-agent-home', mode: 'plain', ctx: null,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    sessionSpawnDirectTargetTransport: { machineId: 'missing-agent-machine',
      prepare: async () => ({ ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
      spawnedSession: { spawn: async () => { throw new Error('An absent Agent must not reach Session creation'); },
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
  });
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'missing-agent-catalog',
    executionTarget: { serverId: 'missing-agent-home', machineId: 'missing-agent-machine' },
    directory: { kind: 'path', path: '/tmp' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'missing.agent.plugin', localId: 'missing-agent' } },
    connectedServices: { v: 2, bindingsByServiceId: {} },
  });
  const result = await deps.sessionSpawnNew!({ ...input, actionCaller: { kind: 'host' }, callerSurface: 'cli',
    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: input.creationKey }),
  });
  expect(SessionSpawnNewResultV1Schema.parse(result)).toMatchObject({ type: 'error', code: 'target_unavailable', retryable: false,
    failureCause: { phase: 'session.agent_target', errorClass: 'Error', errorCode: 'agent_contribution_unavailable', httpStatus: null },
  });
});
