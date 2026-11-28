import { randomUUID } from 'node:crypto';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, ActionOperationAcceptedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { ActionOperationGetV1ResponseSchema, readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { daemonControlPostJson } from './daemon/controlServerClient';
import type { DaemonState } from './daemon/daemon';
import {
  createIsolatedFakeClaudeControlShim,
  FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS,
  readFakeClaudeSessionMcpToolOutcome,
} from './fakeClaude';
import { parseMcpActionExecuteResult } from './externalMcp';
import { waitFor } from './timing';

/** Collect the result of a Session's own reviewed Action without re-invoking it as the person. */
export async function settleReviewedSessionMcpAction(result: ActionExecuteResult, params: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  token: string;
  execute: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;
  decide: (artifactId: string) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
  if (!result.ok) return result;
  const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  if (pending.success) {
    const { consumeDeferredCliApprovalResult } = await import('../../../../apps/cli/src/session/actions/approvals/deferredResult');
    result = await consumeDeferredCliApprovalResult(result, { ...params, onApprovalRequested: params.decide });
    if (!result.ok) return result;
  }
  const accepted = ActionOperationAcceptedResultSchema.safeParse(result.result);
  if (!accepted.success) return result;
  const observed = await params.execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
    serverId: params.serverId, machineId: accepted.data.machineId, operationId: accepted.data.operationId, waitForTerminal: true,
  });
  if (!observed.ok) return observed;
  const receipt = ActionOperationGetV1ResponseSchema.parse(observed.result);
  const terminal = receipt.kind === 'found' && readActionOperationTerminalResultV1(receipt.operation);
  if (!terminal) throw new Error('The reviewed Session Action operation did not settle');
  return terminal;
}

/** The live Session relay supplies the Agent caller and its admitted authority. */
export async function startSessionMcpAgent(params: Readonly<{
  testDir: string;
  directory: string;
  daemonState: Pick<DaemonState, 'httpPort' | 'controlToken'>;
  executeAsPerson: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;
}>) {
  const vendor = await createIsolatedFakeClaudeControlShim({
    testDir: params.testDir, invocationId: randomUUID(), scenario: 'session-mcp-tool',
    captureEnvironmentKeys: [], logFullStdin: false,
  });
  const spawned = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
    port: params.daemonState.httpPort, controlToken: params.daemonState.controlToken,
    path: '/spawn-session', body: {
      directory: params.directory, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      terminal: { mode: 'plain' }, environmentVariables: { HAPPIER_CLAUDE_PATH: vendor.executablePath },
    },
  });
  const sessionId = spawned.data.sessionId;
  if (spawned.status !== 200 || !spawned.data.success || !sessionId) {
    throw new Error(`Agent Session failed to start (HTTP ${spawned.status})`);
  }
  // A completed ordinary turn lets the native runtime confirm its applied
  // model before a tool spends that Session's Agent-start authority.
  const warmed = await params.executeAsPerson('session.message.send', {
    sessionId, message: 'Confirm this Session is ready.', reply: 'wait',
  });
  if (!warmed.ok) {
    await params.executeAsPerson('session.stop', { sessionId });
    throw new Error(`Agent warm-up turn refused (${warmed.errorCode})`);
  }
  return {
    sessionId,
    stop: () => params.executeAsPerson('session.stop', { sessionId }),
    async execute(actionId: string, input: unknown) {
      const commandId = randomUUID();
      const message = JSON.stringify({ id: commandId, name: 'action_execute', arguments: { actionId, input } });
      const sent = await params.executeAsPerson('session.message.send', { sessionId, message });
      if (!sent.ok) throw new Error(`Agent turn refused (${sent.errorCode})`);
      let outcome: Awaited<ReturnType<typeof readFakeClaudeSessionMcpToolOutcome>>;
      await waitFor(async () => {
        outcome = await readFakeClaudeSessionMcpToolOutcome(vendor.logPath, commandId);
        return Boolean(outcome);
      }, { timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, context: `Agent ${actionId}` });
      if (outcome?.failure) throw new Error(`Agent MCP failed (${JSON.stringify(outcome.failure)})`);
      return parseMcpActionExecuteResult(CallToolResultSchema.parse(outcome?.result));
    },
  };
}
