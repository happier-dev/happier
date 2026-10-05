import { TodoSessionLinkInputV1Schema, TodoSessionLinkOutputV1Schema } from '../todos/todoSessionLinkV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
export const TODO_SESSION_LINK_ACTION_SPECS = [{
  id: 'todos.session.link', title: 'Link accepted Session to task',
  description: 'Associate an accepted, qualified Session with the current Zen task. Retry safely; does not create a Session or change human-owned Done.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account',
  placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'todos_session_link' },
  cli: { acceptsServerId: true, commands: [{ path: ['todos', 'session', 'link'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'scope', title: 'Task Home and Account', widget: 'json', required: true },
    { path: 'taskId', title: 'Task', widget: 'text', required: true },
    { path: 'session', title: 'Accepted Session identity', widget: 'json', required: true },
  ] },
  inputSchema: TodoSessionLinkInputV1Schema, outputSchema: TodoSessionLinkOutputV1Schema,
}] as const satisfies readonly PreNormalizedActionSpec[];
