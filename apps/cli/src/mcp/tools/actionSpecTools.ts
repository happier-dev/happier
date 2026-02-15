import { z } from 'zod';

import { getActionSpec, listActionSpecs, type ActionId } from '@happier-dev/protocol';

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

function serializeActionSpec(spec: any): unknown {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description ?? null,
    safety: spec.safety,
    placements: spec.placements ?? [],
    slash: spec.slash ?? null,
    bindings: spec.bindings ?? null,
    examples: spec.examples ?? null,
    surfaces: spec.surfaces,
    inputHints: spec.inputHints ?? null,
  };
}

export function createActionSpecMcpTools(opts?: Readonly<{
  isActionEnabled?: (id: ActionId) => boolean;
}>): Readonly<{
  action_spec_list: Readonly<{ inputSchema: z.ZodTypeAny; handler: (args: unknown) => Promise<McpTextResponse> }>;
  action_spec_get: Readonly<{ inputSchema: z.ZodTypeAny; handler: (args: unknown) => Promise<McpTextResponse> }>;
}> {
  // Optional policy hook for hiding/rejecting disabled actions.
  const isActionEnabled = opts?.isActionEnabled ?? ((_id: ActionId) => true);

  const listSchema = z.object({}).passthrough();
  const getSchema = z.object({ id: z.string().min(1) }).passthrough();

  const action_spec_list = {
    inputSchema: listSchema,
    handler: async (_args: unknown) => {
      const all = listActionSpecs()
        .filter((spec) => isActionEnabled(spec.id))
        .map(serializeActionSpec);
      return okText({ actionSpecs: all });
    },
  } as const;

  const action_spec_get = {
    inputSchema: getSchema,
    handler: async (args: unknown) => {
      const parsed = getSchema.safeParse(args);
      if (!parsed.success) return errText('execution_run_invalid_action_input', 'Invalid params');
      try {
        const spec = getActionSpec(parsed.data.id as any);
        if (!isActionEnabled(spec.id)) return errText('action_disabled', 'Action is disabled');
        return okText({ actionSpec: serializeActionSpec(spec) });
      } catch {
        return errText('execution_run_invalid_action_input', 'Unknown action spec');
      }
    },
  } as const;

  return { action_spec_list, action_spec_get };
}
