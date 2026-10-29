import { readRecord } from '../../../inputs/inputRecords.js';
import { SessionSurfaceItemV1Schema } from '../../../sessions/board/item.js';
import { readSessionVisualCapabilitiesV1 } from '../../../sessions/board/visualPolicy.js';
import { WORK_BOARD_ACTION_IDS_V1, type WorkBoardActionIdV1 } from '../../../boards/actionIdsV1.js';
import { WorkBoardActionInputSchemasV1, WorkBoardActionOutputSchemasV1 } from '../../../boards/actionsV1.js';
import { SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1, SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1, SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1 } from '../../../sessions/board/actions.js';
import { SESSION_BOARD_GET_CLI_PROJECTION, SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION, SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION, SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION, SESSION_VISUAL_DESTINATION_HINT } from '../sessionBoardCli.js';
import { SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 } from '../../../sessions/board/actionIds.js';
import { describeSessionVisualApprovalSummary } from '../definition.js';
import type { PreNormalizedActionSpec } from '../definition.js';

export const WORK_BOARD_ACTION_TITLES: Readonly<Record<WorkBoardActionIdV1, string>> = {
  'boards.list': 'List Boards',
  'boards.apply': 'Edit Board',
};

export const WORK_BOARD_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = WORK_BOARD_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  id, approval: { result: 'required' },
  ...(id === 'boards.apply' ? { approvalPolicy: {
    uiConfirmation: 'direct' as const,
    uiConfirmationForInput: (input: unknown) => {
      const parsed = WorkBoardActionInputSchemasV1['boards.apply'].safeParse(input);
      if (!parsed.success) return true;
      // Board and widget edits are reversible and keep their referenced work, as the same widget
      // edits through widgets.item.* do. Delete removes the Artifact and a widget's network access
      // widens what a guest may reach, so those two confirm.
      return parsed.data.intent.kind === 'delete' || parsed.data.intent.kind === 'widget_network';
    },
  } } : {}),
  title: WORK_BOARD_ACTION_TITLES[id],
  description: id === 'boards.list'
    ? 'List this Home Account’s saved Boards, including their names, item references and layout. This reads Home Boards; session.board.get reads a Session’s own Board.'
    : 'Replay a Board intent through its canonical Artifact. Supports create, delete, update, add_items, remove_item and set_positions; agent moves do not prune positions.',
  // An aggregate intent can delete a Board, so mutation approval uses the shared danger policy.
  safety: id === 'boards.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'boards.list' ? 'read' : 'danger',
  executionPlacement: 'account', requiredAuthority: 'account_automation',
  placements: [],
  bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'), rpcMethod: id },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: WorkBoardActionInputSchemasV1[id],
  outputSchema: WorkBoardActionOutputSchemasV1[id],
  inputHints: { title: WORK_BOARD_ACTION_TITLES[id],
    ...(id === 'boards.list' ? { description: 'Execute with action_execute {"actionId":"boards.list","input":{}}. This discoverable Action does not need a dedicated boards_list tool.' } : {}),
    fields: id === 'boards.list' ? [] : [
    { path: 'boardId', title: 'Board id', widget: 'text', description: 'Optional; must match the intent target when supplied.' },
    { path: 'intent', title: 'Board intent', widget: 'json', required: true,
      description: 'Use kind create, delete, update, add_items, remove_item or set_positions. References include kind and qualifiedId {serverId, id}.' },
  ] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}));

export const SESSION_BOARD_ACTION_SPECS = Object.freeze([
  {
    id: 'session.board.get', executionPlacement: 'session', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'required'},
    title: 'Read Session visuals',
    description: 'Read shared Session visuals and Board placement: item identities, exact revisions, and current Session capabilities. Exact itemIds return full item content.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_get', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.get'] },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","itemIds":["release-checklist"],"limit":100}' },
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
      title: 'Read Board',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'itemIds', title: 'Exact item ids', widget: 'text_list', listSeparator: 'comma' },
        { path: 'cursor', title: 'Page cursor', widget: 'text' },
        { path: 'limit', title: 'Page size', widget: 'integer' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.get'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.get'],
    cli: SESSION_BOARD_GET_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.board.item.upsert', executionPlacement: 'session', toolExposure: { agent: 'direct', mcp: 'direct' }, originalExecution: { nativePurpose: 'session_board_write' }, approvalPolicy: {
      uiConfirmation: 'direct',
      uiConfirmationForInput: (input: unknown) => {
        const item = SessionSurfaceItemV1Schema.safeParse(readRecord(input).item);
        if (!item.success) return true;
        const capabilities = readSessionVisualCapabilitiesV1(item.data);
        // Editing content is reversible; declared egress and host Action access
        // retain the consequence review. Agent contextual safety is unchanged.
        return !capabilities || capabilities.network !== 'none' || capabilities.actions.length > 0;
      },
    }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Show or update a Session visual',
    approvalPresentation: { summary: describeSessionVisualApprovalSummary },
    description: 'Show or update one Session visual at a stable id: declarative charts/tables, hostedHtml bundles, or live widgets. For Daily usage, use item.source.kind="widget" with instance.definition={kind:"builtin",id:"usage_daily"}; bind session to this Session id (null for Account usage), period to {relative:"today"}, and metric to "tokens" or "cost". Live usage reads through the viewer\'s ordinary usage.query Resource admission; no separate Resource tool is needed. Supply item content, or copySource with the exact same-Home source Session, item and revision to create an independent copy in another Session. Same-Session Pin uses layout.update. New visuals default to transcript; board and both destinations require atomic first placement. expectedItemRevision is the exact optimistic-concurrency operand.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_item_upsert', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.item.upsert'] },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","itemId":"orders","expectedItemRevision":null,"destination":"transcript","item":{"v":1,"title":"Orders by channel","frame":"frameless","height":{"mode":"auto","fallback":"regular"},"source":{"kind":"declarative","document":{"version":1,"root":{"kind":"chart","label":"Orders by channel","style":"bar","data":{"kind":"value","value":[{"day":"Mon","channel":"Online","orders":12},{"day":"Mon","channel":"Shop","orders":7},{"day":"Tue","channel":"Online","orders":15},{"day":"Tue","channel":"Shop","orders":9}]},"rows":[],"x":{"path":["day"],"type":"string"},"series":{"path":["channel"],"type":"string"},"value":{"path":["orders"],"type":"number"}}}}}}',
      },
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
      title: 'Show a Session visual',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
        SESSION_VISUAL_DESTINATION_HINT,
        { path: 'item', title: 'Item (or copy source)', widget: 'json' },
        { path: 'copySource', title: 'Exact other-Session visual to copy', widget: 'json' },
        { path: 'placement', title: 'Placement', widget: 'json' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.item.upsert'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.item.upsert'],
    cli: SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.board.item.remove', executionPlacement: 'session', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    irreversible: true,
    title: 'Remove a Session visual',
    description: 'Remove one Session visual. Include expectedLayoutRevision to atomically remove its Board placements. All Session readers lose the visual; installed plugins are unaffected.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_item_remove', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.item.remove'] },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","itemId":"release-checklist","expectedItemRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ","expectedLayoutRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ"}',
      },
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
      title: 'Remove a Board item',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
        { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
        { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text' },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.item.remove'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.item.remove'],
    cli: SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.board.layout.update', executionPlacement: 'session', toolExposure: { agent: 'direct', mcp: 'direct' }, approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Organize the Session Board',
    description: 'Apply exactly one semantic Board organization change: create, rename, move or remove a view, or place, move, unpin, resize or set a shared frame style on an item placement. Frame styles are card or plain; null clears the override. Moves use stable sibling anchors, never indices.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_board_layout_update', mcpToolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.layout.update'] },
    serverTransport: SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","expectedLayoutRevision":"ssr1.AAAACHN5c3JlY18xAAAAAQ","operation":{"op":"item.move","itemId":"release-checklist","fromTabId":"overview","toTabId":"metrics","anchor":{"side":"before","itemId":"burndown"}}}',
      },
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
      title: 'Organize the Board',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text', required: true },
        { path: 'operation', title: 'Layout operation', widget: 'json', required: true },
      ],
    },
    outputSchema: SESSION_BOARD_ACTION_OUTPUT_SCHEMAS_V1['session.board.layout.update'],
    inputSchema: SESSION_BOARD_ACTION_INPUT_SCHEMAS_V1['session.board.layout.update'],
    cli: SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
] as const);

