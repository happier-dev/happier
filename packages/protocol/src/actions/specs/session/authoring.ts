import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { SessionAuthoringOpenV1Schema, SessionAuthoringOpenResultV1Schema } from '../../../plugins/ui/hostApiRequests.js';
import type { PreNormalizedActionSpec } from '../definition.js';


function createSessionAuthoringActionSpecs() {
  return Object.freeze([
  {
    id: 'session.authoring.open', approval: {result: 'required'},
    title: 'Open editable Session draft',
    description: 'Open the ordinary editable New Session composer in an answering Happier client with a validated seed or the readable configuration of an exact-Home source Session. Nothing starts until the user explicitly sends. Returns typed unavailability when no client can answer.',
    sideEffectClass: 'external',
    safety: 'safe',
    executionPlacement: 'client',
    placements: [],
    bindings: { voiceClientToolName: 'openSessionAuthoring', mcpToolName: 'session_authoring_open' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'authoring', 'open'], visibility: 'canonical' }] },
    inputHints: { title: 'Open editable Session draft', fields: [
      { path: 'seed', title: 'New Session seed', widget: 'json' },
      { path: 'sourceSession', title: 'Source Session address', widget: 'json' },
      { path: 'replay', title: 'Replay cutoff', widget: 'json' },
      { path: 'connectedServices', title: 'Connected service selection', widget: 'json' },
    ] },
    examples: { voice: { argsExample: '{"seed":{"prompt":"Help me author this checkout."}}' } },
    inputSchema: SessionAuthoringOpenV1Schema,
    outputSchema: SessionAuthoringOpenResultV1Schema,
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const SESSION_AUTHORING_ACTION_SPECS: ReturnType<typeof createSessionAuthoringActionSpecs> = lazyActionSpecArray(createSessionAuthoringActionSpecs);

