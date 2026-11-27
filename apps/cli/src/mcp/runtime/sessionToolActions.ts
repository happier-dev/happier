import { actionSearchText } from '@happier-dev/protocol/actions/actionCatalog';
import { findActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionSpecSections';
import { normalizeToolSearchQueryV1, scoreToolSearchMatchV1 } from '@happier-dev/protocol/tools/toolCatalogSearchV1';
import { formatCompactToolSignatureV1 } from '@happier-dev/protocol/tools/formatCompactToolSignatureV1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { isSessionToolsBootstrapAction } from '@/agent/tools/happierTools/actionToolCatalog';
import type { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import type { SessionMcpCustomToolsBridge } from './sessionMcpToolsBridge';

type Execute = ReturnType<typeof createActionToolExecutorBridge>['executeActionByToolName'];

export function bindSessionToolActions(params: Readonly<{
  bridge: SessionMcpCustomToolsBridge;
  sessionId: string;
  execute: Execute;
}>): Required<Pick<ActionExecutorDeps, 'sessionToolsSearch' | 'sessionToolsDescribe' | 'sessionToolsCall'>> {
  const summary = (source: string, tool: string, description?: string | null) => ({
    id: source === 'happier' ? tool : `${source}/${tool}`, source, tool,
    ...(description ? { description } : {}),
  });
  return {
    async sessionToolsSearch(input, ctx) {
      const [actions, custom] = await Promise.all([
        params.execute('action_execute', {
          actionId: 'action.spec.search',
          input: { ...input, limit: input.limit ?? null },
        }, params.sessionId, { signal: ctx.signal }),
        params.bridge.list(ctx.signal),
      ]);
      if (!actions.ok) throw createActionExecuteFailureError(actions);
      const { actionSpecs } = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.search'].parse(actions.result);
      const normalized = normalizeToolSearchQueryV1(input.query ?? '');
      const scored = [
        ...actionSpecs
          .filter(action => !isSessionToolsBootstrapAction(action.id))
          .map(action => {
            const item = summary('happier', action.id, action.description);
            const match = scoreToolSearchMatchV1({
              id: item.id,
              title: action.title,
              searchText: actionSearchText(findActionSpec(action.id) ?? action),
            }, normalized);
            // `action.spec.search` already matched this Action against full daemon/plugin metadata.
            return { item, title: action.title, score: match.score > 0 ? match.score : 1, matchesAllTokens: match.matchesAllTokens };
          }),
        ...custom.tools.flatMap(tool => {
          const item = summary(tool.source, tool.name, tool.description);
          const match = scoreToolSearchMatchV1({
            id: item.id,
            title: tool.name,
            searchText: `${tool.source} ${tool.description ?? ''}`,
          }, normalized);
          return match.score > 0 ? [{ item, title: tool.name, ...match }] : [];
        }),
      ].sort((left, right) => {
        if (left.matchesAllTokens !== right.matchesAllTokens) return left.matchesAllTokens ? -1 : 1;
        return right.score - left.score || left.title.localeCompare(right.title);
      });
      return {
        tools: scored.slice(0, input.limit ?? undefined).map(match => match.item),
        ...(custom.warnings.length > 0 ? { warnings: [...custom.warnings] } : {}),
      };
    },
    async sessionToolsDescribe(input, ctx) {
      const { source, tool } = input;
      if (source === 'happier' && !isSessionToolsBootstrapAction(tool)) {
        const definition = await readCompleteActionSpecV1({ actionId: tool, signal: ctx.signal, includeOutputSchema: false,
          read: async args => {
            const result = await params.execute('action_execute', { actionId: 'action.spec.get', input: args },
              params.sessionId, { signal: ctx.signal });
            if (!result.ok) throw createActionExecuteFailureError(result);
            return result.result;
          },
        });
        return { ...summary(source, tool, definition.description), inputSchema: definition.inputSchema,
          signature: formatCompactToolSignatureV1(tool, definition.inputSchema) };
      }
      const custom = await params.bridge.describe?.(source, tool, ctx.signal);
      if (!custom) throw Object.assign(new Error('Tool unavailable.'), { code: 'unknown_tool' });
      const inputSchema = custom.inputSchema ?? { type: 'object' };
      return { ...summary(source, tool, custom.description), inputSchema, signature: formatCompactToolSignatureV1(tool, inputSchema) };
    },
    async sessionToolsCall(input, ctx) {
      const { source, tool, args = {} } = input;
      if (source === 'happier' && isSessionToolsBootstrapAction(tool)) return { ok: false, errorCode: 'unknown_tool' };
      const outcome = source === 'happier'
        ? await params.execute('action_execute', { actionId: tool, input: args }, params.sessionId, {
          signal: ctx.signal, approvalOrigin: ctx.approvalOrigin,
        })
        : await params.bridge.call({ source, toolName: tool, args,
          ...(ctx.approvalOrigin?.kind === 'transcript_tool_call' ? { toolCallId: ctx.approvalOrigin.toolCallId } : {}),
        }, ctx.signal);
      if (outcome.ok) return { ok: true, result: outcome.result ?? null };
      return { ok: false, errorCode: outcome.errorCode,
        ...('failureCause' in outcome && outcome.failureCause ? { refusalCause: outcome.failureCause } : {}),
      };
    },
  };
}
