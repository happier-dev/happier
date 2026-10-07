import { ScopeActionInputSchemas, ScopeActionOutputSchemas } from '../scopeActionFamily.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const clientView = {
  safety: 'safe', requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only', cli: 'discoverable_only' },
  inputHints: { fields: [] },
} as const;

export const SCOPE_ACTION_SPECS = [
  { ...clientView, id: 'session.list.view.get', title: 'Read Sessions view',
    examples: { voice: { argsExample: '{}' } },
    bindings: { sdkMethod: 'session.listView.get' },
    description: 'Read the mounted My work panel filters and available Homes on this client.', sideEffectClass: 'read',
    inputSchema: ScopeActionInputSchemas['session.list.view.get'], outputSchema: ScopeActionOutputSchemas['session.list.view.get'] },
  { ...clientView, id: 'session.list.view.set', title: 'Change Sessions view',
    examples: { voice: { argsExample: '{"includeInactive":true}' } },
    bindings: { sdkMethod: 'session.listView.set' },
    description: 'Change scope, attention, Homes, audiences, tags, source, search or inactive visibility through the mounted Sessions controller.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['session.list.view.set'], outputSchema: ScopeActionOutputSchemas['session.list.view.set'] },
  { ...clientView, id: 'session.list.view.reset', title: 'Reset Sessions view',
    examples: { voice: { argsExample: '{}' } },
    bindings: { sdkMethod: 'session.listView.reset' },
    description: 'Restore the mounted Sessions view defaults through the same Reset control.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['session.list.view.reset'], outputSchema: ScopeActionOutputSchemas['session.list.view.reset'] },
  { ...clientView, id: 'shell.column.get', title: 'Read navigation column',
    examples: { voice: { argsExample: '{}' } },
    description: 'Read whether this client has a navigation column and whether it is visible.', sideEffectClass: 'read',
    inputSchema: ScopeActionInputSchemas['shell.column.get'], outputSchema: ScopeActionOutputSchemas['shell.column.get'] },
  { ...clientView, id: 'shell.column.set', title: 'Show or hide navigation column',
    examples: { voice: { argsExample: '{"visible":true}' } },
    description: 'Show or hide the current destination column on this client through the shell visibility owner.', sideEffectClass: 'write',
    inputSchema: ScopeActionInputSchemas['shell.column.set'], outputSchema: ScopeActionOutputSchemas['shell.column.set'] },
] as const satisfies readonly PreNormalizedActionSpec[];
