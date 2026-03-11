import { z } from 'zod';

import { type ActionId, type ResolvedActionOption } from '@happier-dev/protocol';

import {
  actionOptionsResolveSchema,
  actionSpecGetSchema,
  actionSpecSearchSchema,
  getActionSpecForMcpSurface,
  resolveActionOptionsForMcpSurface,
  searchActionSpecsForMcpSurface,
} from '@/agent/tools/happierTools/actionSpecDiscovery';

type McpTextResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

function okText(value: unknown): McpTextResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function errText(code: string, message: string): McpTextResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ errorCode: code, error: message }) }], isError: true };
}

export function createActionSpecMcpTools(opts?: Readonly<{
  isActionEnabled?: (id: ActionId) => boolean;
  resolveActionOptions?: (args: Readonly<{
    actionId: ActionId | null;
    fieldPath: string | null;
    optionsSourceId: string | null;
    sessionId: string | null;
    limit: number | null;
    query: string | null;
  }>) => Promise<
    | Readonly<{
        ok: true;
        result: Readonly<{
          actionId: ActionId | null;
          fieldPath: string | null;
          optionsSourceId: string | null;
          options: readonly ResolvedActionOption[];
        }>;
      }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
    | null
  >;
}>): Readonly<{
  action_spec_search: Readonly<{ inputSchema: z.ZodTypeAny; handler: (args: unknown) => Promise<McpTextResponse> }>;
  action_spec_get: Readonly<{ inputSchema: z.ZodTypeAny; handler: (args: unknown) => Promise<McpTextResponse> }>;
  action_options_resolve: Readonly<{ inputSchema: z.ZodTypeAny; handler: (args: unknown) => Promise<McpTextResponse> }>;
}> {
  const isActionEnabled = opts?.isActionEnabled ?? ((_id: ActionId) => true);
  const resolveActionOptions = opts?.resolveActionOptions ?? (async () => null);

  const action_spec_search = {
    inputSchema: actionSpecSearchSchema,
    handler: async (args: unknown) => {
      const result = await searchActionSpecsForMcpSurface(args, isActionEnabled);
      return result.ok ? okText(result.result) : errText(result.errorCode, result.error);
    },
  } as const;

  const action_spec_get = {
    inputSchema: actionSpecGetSchema,
    handler: async (args: unknown) => {
      const result = await getActionSpecForMcpSurface(args, isActionEnabled);
      return result.ok ? okText(result.result) : errText(result.errorCode, result.error);
    },
  } as const;

  const action_options_resolve = {
    inputSchema: actionOptionsResolveSchema,
    handler: async (args: unknown) => {
      const result = await resolveActionOptionsForMcpSurface(args, isActionEnabled, resolveActionOptions);
      return result.ok ? okText(result.result) : errText(result.errorCode, result.error);
    },
  } as const;

  return { action_spec_search, action_spec_get, action_options_resolve };
}
