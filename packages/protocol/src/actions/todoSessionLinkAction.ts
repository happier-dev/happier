import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { TodoSessionLinkInputV1Schema, TodoSessionLinkOutputV1Schema } from '../todos/todoSessionLinkV1.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from './actionSpecs.js';
type TodoSessionLinkActionSpec = ActionSpecProjectionMetadata & Readonly<{
  id: 'tasks.internal.session.link';
  approval: { result: 'required' };
  requiredAuthority: 'account_automation';
  inputSchema: typeof TodoSessionLinkInputV1Schema;
  outputSchema: typeof TodoSessionLinkOutputV1Schema;
}>;
export const TODO_SESSION_LINK_ACTION_SPECS: readonly [TodoSessionLinkActionSpec] = lazyActionSpecArray(() => [{
  id: 'tasks.internal.session.link', approval: {result: 'required'}, title: 'Link accepted Session to task',
  description: 'Associate an accepted, qualified Session with the current Happier task. Retry safely; does not create a Session or change human-owned Done.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account',
  originalExecution: { accountRoot: 'allowed' },
  placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'tasks_internal_session_link' },
  cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'session', 'link'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'scope', title: 'Task Home and Account', widget: 'json' },
    { path: 'taskId', title: 'Task', widget: 'text', required: true },
    { path: 'session', title: 'Accepted Session identity', widget: 'json', required: true },
    { path: 'linked', title: 'Linked (false to unlink)', widget: 'boolean' },
  ] },
  inputSchema: TodoSessionLinkInputV1Schema, outputSchema: TodoSessionLinkOutputV1Schema,
}] as const satisfies readonly PreNormalizedActionSpec[]);
