import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { projectSessionActionIssuerRefusal } from '@/api/externalActionIssuerRefusal';
import { createSessionAccountActionExecutor } from './createSessionAccountActionExecutor';
import { createSessionDaemonAuthorityFixture } from './sessionDaemonAuthority.testkit';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('credentialed Session deployment admission', () => {
  const newProject = { name: 'Session deployment', requestKey: 'session-project',
    owner: { kind: 'account', accountId: 'requester-account' } };
  it.each([
    ...(['preview', 'apply'] as const).map(mode => ({
      title: `Environment create ${mode}`, actionId: 'deployments.environments.create' as const,
      input: { serverId: 'home', name: 'Session environment', requestKey: `session-create-${mode}`,
        newProject, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', mode,
        definition: { from: 'image', image: 'nginx:alpine', port: 80 }, controllerMachineId: 'controller-machine' },
    })),
    { title: 'Store prepare', actionId: 'deployments.publish.prepare' as const,
      input: { serverId: 'home', machineId: 'controller-machine', installationId: 'controller-installation', newProject,
        templateRef: { sourceId: 'builtin:dokploy-templates', itemId: 'changedetection',
          version: `sha256:${'1'.repeat(64)}`, ref: { kind: 'content', digest: `sha256:${'1'.repeat(64)}` } } } },
  ])('retains the Home issuer refusal for $title instead of bypassing Machine admission', async ({ actionId, input }) => {
    const refusal = projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_signed_authorization',
    }, 'controller-machine');
    // The remote daemon/Home is the boundary. The Session executor, capability
    // publication, admission witness, protocol parsers and TCP transport are real.
    const daemon = await createSessionDaemonAuthorityFixture({
      sessionId: 'caller-session', execute: async () => refusal,
    });
    const executor = createSessionAccountActionExecutor({
      base: createCliActionExecutor({ token: '', sessionId: 'caller-session', mode: 'plain', ctx: null,
        serverId: 'home', serverHttpBaseUrl: 'https://home.test' }),
      hasAccountAuthority: true,
      client: {
        sessionId: 'caller-session',
        getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
        getActiveTurnAdmissionWitness: () => ({
          turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
          agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
        }),
      },
    });
    try {
      const validated = getActionSpec(actionId).inputSchema.parse(input);
      const result = await executor.execute(actionId, validated, { surface: 'mcp' });
      expect(result).toEqual(refusal);
      expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden', details: {
        phase: 'session.authorization.mint', requiredFact: 'home_signed_authorization', remedy: expect.any(String),
      } });
    } finally { await daemon.close(); }
  });
});
