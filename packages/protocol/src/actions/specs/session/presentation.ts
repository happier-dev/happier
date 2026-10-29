import { SessionUpdatePostInputV1Schema, SessionUpdatePostOutputV1Schema } from '../../../sessions/relations/workerUpdateV1.js';
import { CurrentSessionPresentationActionInputV1Schema, CurrentSessionPresentationActionResultV1Schema } from '../../../sessions/presentation/currentSessionPresentationV1.js';
import type { PreNormalizedActionSpec } from '../definition.js';


export const SESSION_PRESENTATION_ACTION_SPECS = Object.freeze([
  {
    id: 'session.update.post', approval: {result: 'required'}, title: 'Post an update',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'session',
    placements: [], bindings: { mcpToolName: 'session_update_post', voiceClientToolName: 'session_update_post', rpcMethod: 'session.update.post' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    cli: { commands: [] },
    inputHints: { description: 'Persist an update from the current session for its selected followers.', fields: [{ path: 'summary', title: 'Update', widget: 'text', required: true }] },
    inputSchema: SessionUpdatePostInputV1Schema, outputSchema: SessionUpdatePostOutputV1Schema,
  } satisfies PreNormalizedActionSpec,
  // The four shared human/Agent Board intents. People reach them through the UI
  // executor and Agents through the generic Action/tool projection; neither gets a
  // Board-specific dispatcher, parser, or approval rule.
  {
    id: 'session.presentation.apply', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'required'},
    cli: { commands: [{ path: ['session', 'presentation', 'apply'], visibility: 'canonical' }] },
    title: 'Present in the current Session',
    description: 'Apply one reversible Board, Companion, Chat, or Computer/Browser viewer presentation intent to the exact focused client bound to this Agent Session. This never mutates durable Board content or target execution.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'account_automation',
    executionPlacement: 'session',
    placements: [],
    bindings: { mcpToolName: 'session_presentation_apply', voiceClientToolName: 'session_presentation_apply' },
    examples: {
      mcp: { argsExample: '{"intent":{"kind":"board.open","mode":"beside_chat"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Present in this Session',
      description: 'Change what this session shows you right now, such as its board or browser. Nothing saved is changed.', fields: [
        { path: 'intent', title: 'Presentation intent', widget: 'json', required: true },
      ],
    },
    inputSchema: CurrentSessionPresentationActionInputV1Schema,
    outputSchema: CurrentSessionPresentationActionResultV1Schema,
  } satisfies PreNormalizedActionSpec,
] as const);

