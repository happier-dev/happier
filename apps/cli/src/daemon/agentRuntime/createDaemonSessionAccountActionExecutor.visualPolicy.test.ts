import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AccountSettingsSchema } from '@happier-dev/protocol';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';

type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
});

describe('daemon Session visual Account-policy admission', () => {
  it('converges policy before an allowed Agent Action creates an exact-origin visual', async () => {
    const serverHttpBaseUrl = 'https://visual-policy-currentness.test';
    const sessionId = 'bob-session';
    const machineId = 'visual-machine';
    const installationId = 'visual-installation';
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const actionAllowed = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] } });
    const stale = AccountSettingsSchema.parse({ agentHtmlNetworkPolicy: 'allowed', actionsSettingsV1: actionAllowed });
    const current = AccountSettingsSchema.parse({ agentHtmlNetworkPolicy: 'ask', actionsSettingsV1: actionAllowed });
    const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: stale, rawSettings: stale,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    const policy = createActionSettingsProvider({ scopeKey, allowEnvironmentOverride: false });
    let settingsReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${sessionId}`) return { status: 200,
        data: { session: createSessionRecordFixture({ id: sessionId, share: null }) } };
      if (path === '/v2/account/settings') {
        settingsReads++;
        return { status: 200, data: { version: 2, content: { t: 'plain', v: current } } };
      }
      throw new Error(`Unexpected visual policy GET ${path}`);
    });
    const approvals: ApprovalRequest[] = [];
    let writes = 0;
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'visual-profile', serverHttpBaseUrl,
      token: credentials.token, credentials, machineId,
      prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin }) => ({
        accountSettingsVersion: 2,
        target: { kind: 'session', sessionId },
        authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'visual-proof', binding: {
          serverIdentityId: 'srv_visual', accountId: 'owner', custodianAccountId: 'owner',
          authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', machineId, installationId,
          actionId: operation.actionId, requestId: operation.requestId, requestEnvelopeDigest: 'a'.repeat(43),
          target: { kind: 'session', sessionId }, sessionActionOrigin,
          sessionActionSource: { machineId, installationId },
        } }),
      }),
      createExecutor: () => {
        const executor = createActionExecutor({
          readAgentHtmlNetworkPolicy: async () => policy.getAccountSettings()?.agentHtmlNetworkPolicy,
          isActionApprovalRequired: (id, context, input, uiConfirmation) => isApprovalRequiredByActionsSettings(
            id, policy.getActionsSettings(), context, undefined, undefined, input, uiConfirmation),
          approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'visual-approval' }; },
          sessionBoardAction: async () => { writes++; throw new Error('Unexpected direct Board write'); },
        });
        return { execute: (id, actionInput, context) => executor.execute(id, actionInput, {
          ...context,
          runtimeAccountId: 'owner',
          serverIdentityId: 'srv_visual',
          signExternalActionApprovalInput: () => 'a'.repeat(86),
        }) };
      },
    });
    const input = { itemId: 'qa-r67-r8-d2-exact', expectedItemRevision: null, destination: 'transcript', item: {
      v: 1, title: 'Exact origin', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
        'index.html': { mime: 'text/html', contentBase64: 'PGgxPkV4YWN0PC9oMT4=' },
      } }, requestedCapabilities: { networkOrigins: ['https://httpbin.org'] } },
    } };
    const operation: Operation = { kind: 'action.execute', requestId: 'request-1',
      actionId: 'session.board.item.upsert', input, witness: { turnId: 'turn-1', inputId: 'input-1',
        userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
        agentStartCaller: { kind: 'session', sessionId, starterDepth: 1, turnDepth: 2 } } };

    const firstOutcome = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => execute(operation, {
      sessionId, isCurrent: async () => true,
    }));
    expect(firstOutcome).toEqual({ ok: true, result: { kind: 'approval_request_created',
      artifactId: 'visual-approval', actionId: 'session.board.item.upsert' } });
    expect(settingsReads).toBe(1);
    expect(approvals).toHaveLength(1);
    expect(writes).toBe(0);

    await expect(runWithServerHttpBaseUrl(serverHttpBaseUrl, () => execute({ ...operation,
      requestId: 'request-2', input: { ...input, itemId: 'qa-r67-r8-d2-exact-current' },
    }, { sessionId, isCurrent: async () => true }))).resolves.toMatchObject({
      ok: true, result: { kind: 'approval_request_created' },
    });
    expect(settingsReads).toBe(1);
    expect(approvals).toHaveLength(2);
    expect(writes).toBe(0);
  });
});
