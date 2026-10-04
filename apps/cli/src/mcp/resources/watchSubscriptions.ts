import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema, type ServerRequest, type ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { getActionSpec, WaitActionInputV1Schema, type WaitActionInputV1 } from '@happier-dev/protocol';
import type { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import type { ToolRegistrar } from '@/mcp/server/registerHappierMcpBuiltInTools';

export type McpWatchOptions = Readonly<{
  server: McpServer;
  execute: ReturnType<typeof createActionToolExecutorBridge>['executeActionByToolName'];
  defaultSessionId: string;
  isEnabled?: () => boolean;
}>;

const PREFIX = 'happier://watch/';
type Snapshot = Readonly<{ target: WaitActionInputV1['target']; condition: WaitActionInputV1['condition']; snapshot: unknown }>;

function resourceUri(input: WaitActionInputV1): string {
  return PREFIX + Buffer.from(JSON.stringify(input)).toString('base64url');
}

function resourceInput(uri: string): WaitActionInputV1 {
  try {
    if (!uri.startsWith(PREFIX)) throw new Error('Unknown watch resource');
    const input = WaitActionInputV1Schema.parse(JSON.parse(Buffer.from(uri.slice(PREFIX.length), 'base64url').toString('utf8')));
    if (resourceUri(input) !== uri) throw new Error('Noncanonical watch resource');
    return input;
  } catch {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid Happier watch resource URI');
  }
}

/** Connection-local MCP projection of the same passive Action sink as CLI watch. */
export function registerMcpWatchSubscriptions(options: McpWatchOptions): void {
  const { server, execute } = options;
  const subscriptions = new Map<string, ReturnType<typeof observe>>();
  const connection = new AbortController();
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    connection.abort();
    for (const observation of subscriptions.values()) observation.controller.abort();
    subscriptions.clear();
    previousClose?.();
  };

  function observe(input: WaitActionInputV1, onChange?: () => Promise<void>) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, connection.signal]);
    let resolve!: (value: Snapshot) => void;
    let reject!: (error: unknown) => void;
    let initial = true;
    const baseline = new Promise<Snapshot>((yes, no) => { resolve = yes; reject = no; });
    const done = (async () => {
      if (options.isEnabled?.() === false) {
        throw new McpError(ErrorCode.InvalidParams, 'Watch is unavailable', {
          target: input.target, condition: input.condition, disposition: 'permission_denied',
        });
      }
      const result = await execute('action_execute', { actionId: 'wait', input }, options.defaultSessionId, {
        signal,
        onWaitSnapshot: async (snapshot) => {
          if (signal.aborted) return;
          if (initial) {
            initial = false;
            resolve({ target: input.target, condition: input.condition, snapshot });
          } else if (onChange) {
            await onChange();
          }
        },
      });
      if (initial) {
        throw new McpError(ErrorCode.InvalidParams, 'Watch observation refused', result.ok ? result.result : result);
      }
    })();
    // A terminal refusal/error releases this observer. No replay or polling.
    void done.catch((error: unknown) => { reject(error); }).finally(() => { controller.abort(); });
    return { controller, baseline, done };
  }

  async function read(input: WaitActionInputV1, signal?: AbortSignal): Promise<Snapshot> {
    const observation = observe(input);
    const abort = () => observation.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await observation.baseline; }
    finally {
      signal?.removeEventListener('abort', abort);
      abort();
      await observation.done.catch(() => undefined);
    }
  }

  const spec = getActionSpec('wait');
  // The SDK accepts whole Zod 4 schemas at runtime, but its 4.4 declaration identity differs from Protocol's 4.3.
  const tools = server as unknown as ToolRegistrar<RequestHandlerExtra<ServerRequest, ServerNotification>>;
  tools.registerTool('watch', {
    title: 'Watch work',
    description: `${spec.description} Returns a readable resource URI for passive observation. Resource updates are change hints; the MCP host decides whether to wake an agent.`,
    inputSchema: WaitActionInputV1Schema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async (args, extra) => {
    try {
      const input = WaitActionInputV1Schema.parse(args);
      const snapshot = await read(input, extra?.signal);
      return { content: [{ type: 'text', text: JSON.stringify({ ...snapshot, resourceUri: resourceUri(input) }) }] };
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      return { content: [{ type: 'text', text: JSON.stringify(error.data) }], isError: true };
    }
  });
  server.registerResource('happier_work_watch', new ResourceTemplate(`${PREFIX}{request}`, { list: undefined }), {
    title: 'Happier work observation', mimeType: 'application/json',
    description: 'Current owner snapshot for an exact Home-qualified watch target.',
  }, async (uri, _variables, extra) => ({ contents: [{ uri: uri.href, mimeType: 'application/json',
    text: JSON.stringify(await read(resourceInput(uri.href), extra.signal)),
  }] }));

  server.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    const { uri } = request.params;
    const input = resourceInput(uri);
    const existing = subscriptions.get(uri);
    if (existing) { await existing.baseline; return {}; }
    const observation = observe(input, async () => {
      if (!observation.controller.signal.aborted) await server.server.sendResourceUpdated({ uri });
    });
    subscriptions.set(uri, observation);
    const abort = () => observation.controller.abort();
    extra.signal.addEventListener('abort', abort, { once: true });
    if (extra.signal.aborted) abort();
    void observation.done.catch(() => undefined).finally(() => {
      if (subscriptions.get(uri) === observation) subscriptions.delete(uri);
    });
    try { await observation.baseline; return {}; }
    catch (error) { abort(); throw error; }
    finally { extra.signal.removeEventListener('abort', abort); }
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const observation = subscriptions.get(request.params.uri);
    if (observation) {
      subscriptions.delete(request.params.uri);
      observation.controller.abort();
      await observation.done.catch(() => undefined);
    }
    return {};
  });
}
