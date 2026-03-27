import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getActionSpec, isActionSpecSurfacedOn, type ActionId } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { normalizeExecutionRunToolResult } from '@/agent/tools/happierTools/normalizeExecutionRunToolResult';
import type { ExecutionRunServiceResult } from '@/session/services/executionRuns';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function readSessionIdFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const sessionId = normalizeId((args as any).sessionId);
  return sessionId || null;
}

function isExecutionRunServiceResult(value: unknown): value is ExecutionRunServiceResult<unknown> {
  return Boolean(value) && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok');
}

export function createExternalMcpServer(params: Readonly<{
  credentials: Credentials;
  defaultSessionId?: string | null;
}>): Readonly<{ mcp: McpServer; toolNames: string[] }> {
  const toolSurface = 'mcp' as const;

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);
  let defaultSessionId: string | null = normalizeId(params.defaultSessionId) || null;

  const { executor } = createCliActionExecutorHarness(
    {
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: 'cli-global',
      ctx,
    },
    {
      sessionTargetPrimarySet: async ({ sessionId }) => {
        const normalized = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
        defaultSessionId = normalized;
        return { ok: true, sessionId: normalized };
      },
      sessionTargetTrackedSet: async ({ sessionIds }) => {
        const trackedSessionIds = Array.isArray(sessionIds)
          ? sessionIds.map((id) => String(id ?? '').trim()).filter(Boolean)
          : [];
        return { ok: true, sessionIds: trackedSessionIds };
      },
    },
  );

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  registerHappierMcpResources(mcp as any, {
    surface: toolSurface,
    isActionEnabled: (id) => isActionEnabledByEnv(id as any, { surface: toolSurface }),
  });

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabledByEnv(id as any, { surface: toolSurface });
    },
    surface: toolSurface,
  });

  const { toolNames } = registerHappierMcpBuiltInTools(mcp as any, {
    sessionId: 'cli-global',
    surface: toolSurface,
    resolveSessionId: (toolArgs) => readSessionIdFromToolArgs(toolArgs) ?? defaultSessionId ?? 'cli-global',
    deps: {
      changeTitle: async (_sessionId, title) => {
        const sessionId = normalizeId(_sessionId);
        if (!sessionId) return { success: false, error: 'session_not_selected' };
        const res = await executor.execute(
          'session.title.set' as ActionId,
          { sessionId, title },
          { surface: toolSurface, defaultSessionId: sessionId },
        );
        return res.ok ? { success: true, title } : { success: false, error: res.error };
      },
      startExecutionRun: async (sessionId, request) => {
        const res = await executor.execute(
          'execution.run.start' as ActionId,
          request,
          { surface: toolSurface, defaultSessionId: sessionId },
        );
        if (!res.ok) {
          return { ok: false, errorCode: res.errorCode, error: res.error };
        }
        if (res.result && typeof res.result === 'object' && (res.result as any).kind === 'approval_request_created') {
          return { ok: true, result: res.result };
        }
        if (!isExecutionRunServiceResult(res.result)) {
          return { ok: false, errorCode: 'invalid_execution_run_result', error: 'invalid_execution_run_result' };
        }
        return normalizeExecutionRunToolResult(res.result);
      },
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: async (resolverArgs) =>
        await actionToolBridge.resolveActionOptions(
          resolverArgs,
          readSessionIdFromToolArgs(resolverArgs) ?? defaultSessionId ?? 'cli-global',
        ),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });

  return { mcp, toolNames };
}
