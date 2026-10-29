import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ExternalSessionAttachRequestSchema, ExternalSessionAttachResponseSchema, ExternalSessionBackgroundFollowActionInputV1Schema, ExternalSessionDetachRequestSchema, ExternalSessionDetachResponseSchema, ExternalSessionFollowPolicySetRequestSchema, ExternalSessionLinkEnsureRequestSchema, ExternalSessionLinkEnsureResponseSchema, ExternalSessionCandidateDeleteRequestSchema, ExternalSessionCandidateDeleteResponseSchema, ExternalSessionsCandidatesListRequestSchema, ExternalSessionsCandidatesListResponseSchema, ExternalSessionStatusGetRequestSchema, ExternalSessionStatusActionInputV1Schema, ExternalSessionTranscriptPageRequestSchema, ExternalSessionTranscriptPageResponseSchema, ExternalSessionTranscriptReadAfterRequestSchema, ExternalSessionTranscriptReadAfterResponseSchema, ExternalSessionViewerFollowActionInputV1Schema, ExternalSessionViewerFollowActionResultV1Schema, ExternalSessionViewerUnfollowActionInputV1Schema, ExternalSessionViewerUnfollowActionResultV1Schema } from '../../../sessions/external/daemonRpcV1.js';
import { ExternalSessionTranscriptRefreshReadAfterRequestV1Schema, ExternalSessionTranscriptRefreshReadAfterResponseV1Schema } from '../../../sessions/external/secureRefreshV1.js';
import { ExternalSessionTakeoverInputV1Schema, ExternalSessionTakeoverResultV1Schema } from '../../../sessions/external/takeoverV1.js';
import type { ActionSurfaceBindingContext, PreNormalizedActionSpec } from '../definition.js';
import { type ActionInputHints } from '../../metadata.js';
import { ExternalSessionBackgroundFollowActionResultV1Schema, ExternalSessionFollowPolicySetResponseSchema, ExternalSessionStatusGetResponseSchema, ExternalSessionStatusActionResultV1Schema } from '../../../sessions/external/daemonRpcV1.js';
import { ExternalSessionMaterializeStartInputV1Schema, ExternalSessionMaterializeActionInputV1Schema, ExternalSessionMaterializeActionResultV1Schema, ExternalSessionOperationActionResultV1Schema, ExternalSessionOperationActionResponseV1Schema, ExternalSessionOperationCancelInputV1Schema, ExternalSessionOperationDiscardInputV1Schema, ExternalSessionOperationResumeInputV1Schema, ExternalSessionOperationRetryInputV1Schema, ExternalSessionOperationStatusInputV1Schema, ExternalSessionOperationTransportReferenceV1Schema, ExternalSessionTakeoverStartInputV1Schema, projectExternalSessionMaterializeActionResultV1, projectExternalSessionOperationActionResultV1 } from '../../../sessions/external/operationActionSchemasV1.js';
import { RPC_METHODS } from '../../../rpc/methods.js';


export const EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS: ActionInputHints['fields'] = [
  { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
  { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
  { path: 'revision', title: 'Revision', widget: 'text', required: true },
];

export function identityActionSurfaceValue(value: unknown): unknown {
  return value;
}

export function projectExternalSessionOperationResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const semantic = ExternalSessionOperationActionResultV1Schema.safeParse(value);
  const materialize = ExternalSessionMaterializeActionInputV1Schema.safeParse(
    context.input,
  );
  const reference = ExternalSessionOperationStatusInputV1Schema.safeParse(
    context.input,
  );
  const sessionId = materialize.success
    ? materialize.data.request.sessionId
    : reference.success
      ? reference.data.sessionId
      : null;
  if (!sessionId) throw new Error('external_session_operation_input_required');
  if (semantic.success) {
    if (
      semantic.data.ok
      && semantic.data.operation.sessionId !== sessionId
    ) {
      throw new Error('external_session_operation_session_mismatch');
    }
    return semantic.data;
  }
  return projectExternalSessionOperationActionResultV1(value, sessionId);
}

export function projectExternalSessionMaterializeResult(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const materialize = ExternalSessionMaterializeActionInputV1Schema.parse(
    context.input,
  );
  return projectExternalSessionMaterializeActionResultV1(
    value,
    materialize.request.sessionId,
  );
}

export function projectExternalSessionStatusResult(value: unknown): unknown {
  const response = ExternalSessionStatusGetResponseSchema.parse(value);
  return response.ok
    ? ExternalSessionStatusActionResultV1Schema.parse({
        ok: true,
        machineOnline: response.machineOnline,
        runnerActive: response.runnerActive,
        activity: response.activity,
        canTakeOverDirect: response.canTakeOverDirect,
        canTakeOverPersist: response.canTakeOverPersist,
        canForceStop: response.canForceStop,
        ...(response.lastKnownActivityAtMs === undefined
          ? {}
          : { lastKnownActivityAtMs: response.lastKnownActivityAtMs }),
      })
    : ExternalSessionStatusActionResultV1Schema.parse({
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

export function projectExternalSessionBackgroundFollowResult(value: unknown): unknown {
  const response = ExternalSessionFollowPolicySetResponseSchema.parse(value);
  return ExternalSessionBackgroundFollowActionResultV1Schema.parse(response.ok
    ? {
        ok: true,
        enabled: response.enabled,
        leaseActive: response.leaseActive,
        updatedAtMs: response.updatedAtMs,
      }
    : {
        ok: false,
        errorCode: response.errorCode,
        error: response.error,
      });
}

export const EXTERNAL_SESSION_OPERATION_ACTION_SPECS_V1 = [
  {
    id: 'sessions.external.materialize.start', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Materialize external session',
    description: 'Start or converge on the canonical external-session materialization operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START, mcpToolName: 'sessions_external_materialize_start' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionMaterializeStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionMaterializeActionInputV1Schema,
        projectOutput: projectExternalSessionMaterializeResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionMaterializeActionResultV1Schema,
    inputSchema: ExternalSessionMaterializeActionInputV1Schema,
    inputHints: {
      description: 'Bring a session you started outside Happier into Happier so you can follow it here.',
      title: 'Materialize external session',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.takeover.start', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start external session takeover',
    description: 'Start or converge on the canonical external-session takeover operation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionTakeoverStartInputV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResponseV1Schema,
    inputSchema: ExternalSessionTakeoverStartInputV1Schema,
    inputHints: {
      description: 'Start moving a session you began outside Happier into Happier, so you can steer it here.',
      title: 'Start external session takeover',
      fields: [{ path: 'request', title: 'Operation request', widget: 'textarea', required: true }],
    },
  },
  {
    id: 'sessions.external.operation.status.get', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Get external session operation status',
    description: 'Passively read the current canonical external-session operation projection.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, mcpToolName: 'sessions_external_operation_status_get' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationStatusInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationStatusInputV1Schema,
    inputHints: {
      description: 'See how far an import or takeover of an outside session has got.',
      title: 'Get external session operation status',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.cancel', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Cancel external session operation',
    description: 'Record an explicit cancellation intent for the current operation revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL, mcpToolName: 'sessions_external_operation_cancel' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationCancelInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationCancelInputV1Schema,
    inputHints: {
      description: 'Stop an import or takeover of an outside session that is still in progress.',
      title: 'Cancel external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.resume', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Resume external session operation',
    description: 'Explicitly resume a passively hydrated operation from its durable checkpoint.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, mcpToolName: 'sessions_external_operation_resume' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationResumeInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationResumeInputV1Schema,
    inputHints: {
      description: 'Pick up an interrupted import or takeover of an outside session where it left off.',
      title: 'Resume external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.retry', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Retry external session operation',
    description: 'Explicitly retry the canonical recovery phase at the current revision.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY, mcpToolName: 'sessions_external_operation_retry' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationRetryInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationRetryInputV1Schema,
    inputHints: {
      description: 'Try a failed import or takeover of an outside session again.',
      title: 'Retry external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
  {
    id: 'sessions.external.operation.discard', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Discard external session operation',
    description: 'Destructively discard an eligible initial partial operation and its private staging.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD, mcpToolName: 'sessions_external_operation_discard' },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionOperationTransportReferenceV1Schema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionOperationActionResponseV1Schema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionOperationDiscardInputV1Schema,
        projectOutput: projectExternalSessionOperationResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionOperationActionResultV1Schema,
    inputSchema: ExternalSessionOperationDiscardInputV1Schema,
    inputHints: {
      description: 'Throw away an unfinished import of an outside session and the partial copy it made.',
      title: 'Discard external session operation',
      fields: EXTERNAL_SESSION_OPERATION_REFERENCE_INPUT_HINT_FIELDS,
    },
  },
] as const satisfies readonly PreNormalizedActionSpec[];


export const ExternalSessionTakeoverActionInputSchema = ExternalSessionTakeoverInputV1Schema;

export const EXTERNAL_SESSION_ACTION_SPECS = Object.freeze([
  {
    id: 'sessions.external.candidates.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List external session candidates',
    description: 'List attachable external session candidates through the external-session machine RPC.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY],
      sdkMethod: 'sessions.external.listCandidates',
      mcpToolName: 'sessions_external_candidates_list',
    },
    cli: { commands: [{ path: ['sessions', 'external', 'candidates', 'list'], visibility: 'canonical' }], acceptsServerId: true },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionsCandidatesListResponseSchema,
    inputSchema: ExternalSessionsCandidatesListRequestSchema,
    inputHints: {
      description: 'See sessions you started outside Happier that you can bring in.',
      title: 'List external session candidates',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'limit', title: 'Limit', widget: 'text' },
        { path: 'searchTerm', title: 'Search term', widget: 'text' },
        { path: 'searchTarget', title: 'Search target (metadata or content)', widget: 'text' },
        { path: 'searchMode', title: 'Metadata search mode (fast or full)', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.candidate.delete', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    title: 'Delete external session candidate',
    description: "Delete one Agent-owned session a resume-only external-session listing surfaced. The Agent's own record is removed; no Happier Session is deleted.",
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_CANDIDATE_DELETE,
      mcpToolName: 'sessions_external_candidate_delete',
      // cli-v0.2.1 / ui-web-v0.2.0 name this same operation
      // `daemon.directSessions.candidate.delete` and carry `providerId`. It is
      // the identical Agent-side deletion addressed by the identical opaque
      // identifier, so the released spelling dispatches this canonical Action
      // instead of gaining a second decision-maker; the request reader admits
      // the released identity and the registrar maps the released failure
      // literal back. Remove when no supported client or rollback target sends
      // it.
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_CANDIDATE_DELETE_LEGACY],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionCandidateDeleteResponseSchema,
    inputSchema: ExternalSessionCandidateDeleteRequestSchema,
    inputHints: {
      description: 'Delete a session you started outside Happier from that agent\'s own list; nothing in Happier is deleted.',
      title: 'Delete external session candidate',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.link.ensure', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Ensure external session link',
    description: 'Create or reuse the Happier link for an external provider session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
      mcpToolName: 'sessions_external_link_ensure',
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionLinkEnsureResponseSchema,
    inputSchema: ExternalSessionLinkEnsureRequestSchema,
    inputHints: {
      description: 'Link a session you started outside Happier so it shows here.',
      title: 'Ensure external session link',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'titleHint', title: 'Title hint', widget: 'text' },
        { path: 'directoryHint', title: 'Directory hint', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.follow', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Follow external session lease',
    description: 'Attach an ephemeral follow lease to an external session link.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionAttachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionAttachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerFollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerFollowActionInputV1Schema,
    inputHints: {
      description: 'Keep up with a session you started outside Happier while you watch it.',
      title: 'Follow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text' },
        { path: 'ttlMs', title: 'Lease TTL milliseconds', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.unfollow', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Unfollow external session lease',
    description: 'Detach an external-session follow lease.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionDetachRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionDetachResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionViewerUnfollowActionResultV1Schema,
    inputSchema: ExternalSessionViewerUnfollowActionInputV1Schema,
    inputHints: {
      description: 'Stop keeping up with a session you started outside Happier.',
      title: 'Unfollow external session lease',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'leaseId', title: 'Lease id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.backgroundFollow.set', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set external session follow policy',
    description: 'Enable or disable background following for an external session.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
      mcpToolName: 'sessions_external_background_follow_set',
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionFollowPolicySetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionFollowPolicySetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
        projectOutput: projectExternalSessionBackgroundFollowResult,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    cli: { commands: [{ path: ['sessions', 'external', 'background-follow', 'set'], positionals: ['sessionId'], visibility: 'canonical' }], acceptsServerId: true },
    sideEffectClass: 'write',
    outputSchema: ExternalSessionBackgroundFollowActionResultV1Schema,
    inputSchema: ExternalSessionBackgroundFollowActionInputV1Schema,
    inputHints: {
      description: 'Choose whether Happier keeps up with an outside session even when you are not watching it.',
      title: 'Set external session follow policy',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.status.get', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Get external session status',
    description: 'Read bounded status and takeover readiness for a linked external session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY],
    },
    surfaceBindings: {
      rpc: {
        inputSchema: ExternalSessionStatusGetRequestSchema,
        decodeInput: identityActionSurfaceValue,
        outputSchema: ExternalSessionStatusGetResponseSchema,
        encodeOutput: identityActionSurfaceValue,
      },
      plugin: {
        inputSchema: ExternalSessionStatusActionInputV1Schema,
        projectOutput: projectExternalSessionStatusResult,
      },
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionStatusActionResultV1Schema,
    inputSchema: ExternalSessionStatusActionInputV1Schema,
    inputHints: {
      description: 'See the state of a session you started outside Happier, and whether you can take it over.',
      title: 'Get external session status',
      fields: [
        { path: 'sessionId', title: 'Linked session id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.transcript.page', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Page external session transcript',
    description: 'Read a bounded transcript page for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY],
      sdkMethod: 'sessions.external.pageTranscript',
      mcpToolName: 'sessions_external_transcript_page',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: ExternalSessionTranscriptPageResponseSchema,
    inputSchema: ExternalSessionTranscriptPageRequestSchema,
    inputHints: {
      description: 'Read earlier parts of a session you started outside Happier.',
      title: 'Page external session transcript',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'direction', title: 'Direction', widget: 'select', required: true, options: [
          { value: 'older', label: 'Older' },
          { value: 'newer', label: 'Newer' },
        ] },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.transcript.readAfter', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Read external session transcript after cursor',
    description: 'Read bounded transcript deltas after a cursor for an external provider session.',
    safety: 'safe',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      rpcMethodAliases: [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY],
      sdkMethod: 'sessions.external.readAfterTranscript',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'read',
    outputSchema: lazyZodSchema(() => z.union([
      ExternalSessionTranscriptReadAfterResponseSchema,
      ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
    ])),
    inputSchema: lazyZodSchema(() => z.union([
      ExternalSessionTranscriptReadAfterRequestSchema,
      ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
    ])),
    inputHints: {
      description: 'Read what an outside session has said since a point in its conversation.',
      title: 'Read external session transcript after cursor',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
        { path: 'remoteSessionId', title: 'Remote session id', widget: 'text', required: true },
        { path: 'source', title: 'External source', widget: 'textarea', required: true },
        { path: 'cursor', title: 'Cursor', widget: 'text', required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' },
        { path: 'maxItems', title: 'Maximum items', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.external.takeover', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    title: 'Take over external session',
    description: 'Move a linked external session into a Happier-managed terminal runtime.',
    safety: 'danger',
    placements: [],
    bindings: {
      rpcMethod: RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
      rpcMethodAliases: [
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      ],
      sdkMethod: 'sessions.external.takeover.execute',
    },
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: ExternalSessionTakeoverResultV1Schema,
    inputSchema: ExternalSessionTakeoverActionInputSchema,
    inputHints: {
      description: 'Move a session you started outside Happier into Happier so you can steer it here.',
      title: 'Take over external session',
      fields: [
        { path: 'linkedSessionId', title: 'Linked session id', widget: 'text', required: true },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'targetRuntimeMode', title: 'Target runtime mode', widget: 'select', required: true, options: [
          { value: 'terminal', label: 'Terminal' },
        ] },
        { path: 'storageMode', title: 'Storage mode', widget: 'select', required: true, options: [
          { value: 'external-linked', label: 'External linked' },
          { value: 'persisted', label: 'Persisted' },
        ] },
      ],
    },
  } satisfies PreNormalizedActionSpec,
] as const);

