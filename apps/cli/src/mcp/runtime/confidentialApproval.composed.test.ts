import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { BrowserAutomationSecretFillRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliApprovalCreation } from '@/session/actions/approvals/creation';
import type { AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

it.each([
  { surface: 'agent', profile: 'home' },
  { surface: 'mcp', profile: 'home' },
  { surface: 'agent', profile: 'local-home-profile' },
] as const)('creates the ordinary confidential approval through $surface MCP at $profile without a caller request id', async ({ surface, profile }) => {
  const input = BrowserAutomationSecretFillRequestV1Schema.parse({
    serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
    browserSessionId: 'browser', viewId: 'view', tabId: 'tab', frameId: 'frame', documentId: 'document',
    navigationGeneration: 0, origin: 'https://example.test',
    field: { fieldId: 'field', focusId: 'focus', locator: '#login' },
  });
  // Only the Account Artifact persistence boundary is substituted. Both the CLI
  // adapter and Protocol exact-id creation/rejoin owner run against stored JSON.
  const artifacts = new Map<string, AccountArtifact>();
  const creation = createCliApprovalCreation({ getAccountId: () => 'account', prepareRequesterRecipient: async () => {},
    accountArtifactStore: {
      read: async id => artifacts.get(id) ?? null,
      resolvePrivateSourceId: async () => { throw new Error('Unexpected development install lookup'); },
      create: async ({ artifactId, header, body }) => {
        if (!artifactId) throw new Error('Expected captured approval identity');
        if (typeof body !== 'string') throw new Error('Expected serialized approval body');
        if (!artifacts.has(artifactId)) artifacts.set(artifactId, { artifactId, header, body,
          ownerAccountId: 'account', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 },
          seq: 1, createdAt: 1, updatedAt: 1 });
        return { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } };
      },
    },
  });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...creation });
  const bridge = createActionToolExecutorBridge({ surface, executor: {
    execute: (id, args, context) => executor.execute(id, args, { ...context,
      serverId: profile, serverIdentityId: 'home', runtimeAccountId: 'account' }),
  } });
  const server = new McpServer({ name: 'happier', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId: 'session', sessionMachineId: 'machine', surface,
    deps: { ...bridge, changeTitle: async () => ({ success: true }),
      resolveActionOptions: args => bridge.resolveActionOptions(args, 'session') } });
  const client = new Client({ name: 'confidential-approval', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'browser.automation.secret.fill', input,
    } }));
    const text = response.content.find(block => block.type === 'text');
    if (text?.type !== 'text') throw new Error('Missing Action result');
    const result: unknown = JSON.parse(text.text);
    const proposed = [...artifacts.values()][0];
    const admission = ApprovalRequestV2Schema.safeParse(proposed ? JSON.parse(String(proposed.body)) : null);
    const issues = admission.success ? [] : admission.error.issues.map(issue => ({ path: issue.path, code: issue.code }));
    expect(result, JSON.stringify(issues)).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String),
      actionId: 'browser.automation.secret.fill' });
    expect(response.isError).not.toBe(true);
    expect(artifacts.size).toBe(1);
    const artifact = [...artifacts.values()][0]!;
    expect(result).toMatchObject({ artifactId: artifact.artifactId });
    const stored = ApprovalRequestV2Schema.parse(JSON.parse(String(artifact.body)));
    expect(stored).toMatchObject({ status: 'open', actionArgs: input, createdBy: { surface, sessionId: 'session' },
      executionOriginV1: { surface, sessionId: 'session', machineId: 'machine', accountId: 'account', requestId: expect.any(String) } });
    expect(await creation.approvalsCreate({ request: stored, serverId: profile })).toEqual({ artifactId: artifact.artifactId, request: stored });
    expect(await creation.approvalsCreate({ request: stored, serverId: 'home' })).toEqual({ artifactId: artifact.artifactId, request: stored });
    const changedInput = { ...input, viewId: 'another-view' };
    await expect(creation.approvalsCreate({ request: { ...stored, actionArgs: changedInput,
      preview: { actionId: stored.actionId, actionArgs: changedInput } }, serverId: profile }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    for (const changedScope of [{ serverId: 'foreign-home' }, { sessionId: 'foreign-session' }, { machineId: 'foreign-machine' }]) {
      const actionArgs = { ...input, ...changedScope };
      expect(ApprovalRequestV2Schema.safeParse({ ...stored, actionArgs,
        preview: { actionId: stored.actionId, actionArgs } }).success).toBe(true);
    }
    expect(await executor.execute('approval.request.decide', { artifactId: artifact.artifactId, decision: 'approve' },
      { surface, authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    const rejectedValue = 'PRIVATE-FIX-D26B-INPUT';
    const malformed = await client.callTool({ name: 'action_execute', arguments: {
      actionId: stored.actionId, input: { ...input, value: rejectedValue },
    } });
    expect(JSON.stringify(malformed)).toContain('invalid_parameters');
    expect(JSON.stringify(malformed)).not.toContain(rejectedValue);
    expect(artifacts.size).toBe(1);
  } finally { await client.close(); await server.close(); }
});
