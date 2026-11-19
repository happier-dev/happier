import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { SessionAuthoringOpenV1Schema, SessionAuthoringOpenResultV1Schema } from '../../../plugins/ui/hostApiRequests.js';
import { SessionInputHandoffInputV1Schema, SessionInputHandoffResultV1Schema } from '../../../sessions/messages/sessionInputHandoffV1.js';
import { SESSION_INPUT_HANDOFF_ACTION_ID_V1 } from '../../actionIds.js';
import { redactObservationInputPaths } from '../observationRedaction.js';
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
  {
    id: SESSION_INPUT_HANDOFF_ACTION_ID_V1, approval: { result: 'required' },
    title: 'Hand input to a Session',
    description: 'Resolve configured, existing or new Session delivery through the shared Session host. Explicit New opens an editable draft without starting or sending. Existing sends retain ordinary Pending admission and the supplied intent key.',
    sideEffectClass: 'write', safety: 'safe', executionPlacement: 'account',
    projectObservationInput: redactObservationInputPaths('input', 'defaults.destination.seed', 'defaults.destination.spawn', 'newSession'),
    placements: [], bindings: { mcpToolName: 'session_input_handoff' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'input', 'handoff'], visibility: 'canonical' }] },
    inputHints: { title: 'Hand input to a Session', fields: [
      { path: 'sessionChoice', title: 'Session destination', widget: 'json', required: true },
      { path: 'delivery', title: 'Delivery choice', widget: 'select', required: true, options: [
        { value: 'configured', label: 'Configured' }, { value: 'compose', label: 'Compose' }, { value: 'send', label: 'Send' },
      ] },
      { path: 'defaults', title: 'Configured launch defaults', widget: 'json' },
      { path: 'newSession', title: 'New Session placement and seed', widget: 'json' },
      { path: 'input', title: 'Requested work and descriptive evidence', widget: 'json', required: true },
      { path: 'idempotencyKey', title: 'Delivery intent key', widget: 'text', required: true },
    ] },
    inputSchema: SessionInputHandoffInputV1Schema, outputSchema: SessionInputHandoffResultV1Schema,
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const SESSION_AUTHORING_ACTION_SPECS: ReturnType<typeof createSessionAuthoringActionSpecs> = lazyActionSpecArray(createSessionAuthoringActionSpecs);

