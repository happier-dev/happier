import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { FollowPolicyV1Schema } from '../../../sessions/follow/sessionFollowPolicyV1.js';
import { z } from '../../../zodRuntimePolicy.js';
import { SessionFollowActionInputSchemasV1, SessionFollowActionOutputSchemasV1 } from '../../../sessions/follow/actions.js';
import { SESSION_FOLLOW_HTTP_PATHS_V1 } from '../../../sessions/follow/api.js';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '../../../sessions/follow/sessionFollowSourcesApi.js';
import { DELIVERY_MUTE_HTTP_PATHS_V1, FollowReceiverRefV1Schema } from '../../../sessions/follow/sessionDeliveryMuteV1.js';
import type { PreNormalizedActionSpec } from '../definition.js';


export const SessionFollowPreferencesCliInputSchema = lazyZodSchema(() => z.strictObject({
  assigned: z.enum(['on', 'off']),
  direct: z.enum(['on', 'off']),
  team: z.enum(['on', 'off']),
  group: z.enum(['on', 'off']),
  managerPolicy: z.optional(FollowPolicyV1Schema),
  runReportPolicy: z.optional(FollowPolicyV1Schema),
  discussionReceivePolicy: z.optional(FollowPolicyV1Schema),
}));

export function deliveryMuteActionMetadata(operation: 'set' | 'remove' | 'list') {
  return {
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    approval: operation === 'list' ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
    title: operation === 'list' ? 'List receiver delivery mutes' : operation === 'set' ? 'Mute deliveries to a receiver' : 'Unmute deliveries to a receiver',
    description: 'Inspect or change exact sender and Follow-source suppression for one receiver on this Home.',
    safety: operation === 'list' ? 'safe' : 'danger',
    ...(operation === 'list' ? {} : { safetyForInput: (input: unknown) => {
      const parsed = FollowReceiverRefV1Schema.safeParse((input as { receiver?: unknown } | null)?.receiver);
      return parsed.success && parsed.data.kind === 'account' ? 'safe' as const : 'danger' as const;
    } }),
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'delivery', 'mute', operation], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: `session_delivery_mute_${operation}`, voiceClientToolName: `session_delivery_mute_${operation}` },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: operation === 'list' ? 'read' : 'write',
    inputHints: { fields: [{ path: 'receiver', title: 'Receiver', widget: 'json', required: true },
      ...(operation === 'list' ? [] : [{ path: 'scope', title: 'Mute scope', widget: 'json' as const, required: true }])] },
    serverTransport: { method: operation === 'list' ? 'GET' : operation === 'set' ? 'PUT' : 'DELETE',
      path: DELIVERY_MUTE_HTTP_PATHS_V1.account },
  } as const satisfies Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema'>;
}

function createSessionFollowActionSpecs() {
  return Object.freeze([
  {
    id: 'follow.preferences.get', approval: {result: 'required'},
    title: 'Get Follow defaults',
    description: 'Get Follow defaults for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'preferences', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_preferences_get', voiceClientToolName: 'follow_preferences_get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.preferences.get'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.preferences.get'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'follow.preferences.set', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set Follow defaults',
    description: 'Set Follow defaults for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: {
      commands: [{ path: ['follow', 'preferences', 'set'], visibility: 'canonical' }],
      inputSchema: SessionFollowPreferencesCliInputSchema,
      bindInput: (value) => {
        const input = SessionFollowPreferencesCliInputSchema.parse(value);
        return { defaultRules: { assigned: input.assigned === 'on', direct: input.direct === 'on', team: input.team === 'on', group: input.group === 'on' },
          ...(input.managerPolicy ? { managerPolicy: input.managerPolicy } : {}),
          ...(input.runReportPolicy ? { runReportPolicy: input.runReportPolicy } : {}),
          ...(input.discussionReceivePolicy ? { discussionReceivePolicy: input.discussionReceivePolicy } : {}) };
      },
    },
    placements: [],
    bindings: { mcpToolName: 'follow_preferences_set', voiceClientToolName: 'follow_preferences_set' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.preferences.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.preferences.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.preferences },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'follow.list', approval: {result: 'none'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    sideEffectClass: 'read',
    title: 'List followed sessions',
    description: 'List the sessions whose updates are included with this session\'s next turn.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_list', voiceClientToolName: 'follow_list' },
    examples: {
      mcp: { argsExample: '{"direction":"following","receiver":{"kind":"session","sessionId":"{{sessionId}}"}}' },
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
      title: 'List followed sessions',
      fields: [{ path: 'receiver', title: 'Receiver', widget: 'json', required: false },
        { path: 'source', title: 'Source', widget: 'json', required: false },
        { path: 'direction', title: 'Direction', widget: 'text', required: true }],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['follow.list'],
    inputSchema: SessionFollowActionInputSchemasV1['follow.list'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'follow.preview', sideEffectClass: 'read', approval: {result: 'none'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Preview Follow rule',
    description: 'Preview the authorized matching corpus without creating Follow enrollments.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'preview'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_preview', voiceClientToolName: 'follow_preview' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Preview Follow rule',
      fields: [
        { path: 'receiver', title: 'Receiver', widget: 'json', required: true },
        { path: 'filter', title: 'Filter', widget: 'json', required: true },
      ],
    },
    outputSchema: SessionFollowActionOutputSchemasV1['follow.preview'],
    inputSchema: SessionFollowActionInputSchemasV1['follow.preview'],
  } satisfies PreNormalizedActionSpec,
  {
    ...deliveryMuteActionMetadata('set'),
    id: 'session.delivery.mute.set',
    inputSchema: SessionFollowActionInputSchemasV1['session.delivery.mute.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.delivery.mute.set'],
  } satisfies PreNormalizedActionSpec,
  {
    ...deliveryMuteActionMetadata('remove'),
    id: 'session.delivery.mute.remove',
    inputSchema: SessionFollowActionInputSchemasV1['session.delivery.mute.remove'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.delivery.mute.remove'],
  } satisfies PreNormalizedActionSpec,
  {
    ...deliveryMuteActionMetadata('list'),
    id: 'session.delivery.mute.list',
    inputSchema: SessionFollowActionInputSchemasV1['session.delivery.mute.list'],
    outputSchema: SessionFollowActionOutputSchemasV1['session.delivery.mute.list'],
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const SESSION_FOLLOW_ACTION_SPECS: ReturnType<typeof createSessionFollowActionSpecs> = lazyActionSpecArray(createSessionFollowActionSpecs);


function createSessionFollowRelationActionSpecs() {
  return Object.freeze([
  {
    id: 'follow.get', approval: {result: 'required'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Get Session Follow',
    description: 'Get Session Follow for the authenticated Account.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_get', voiceClientToolName: 'follow_get' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.get'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.get'],
    serverTransport: { method: 'GET', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'follow.set', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Set Session Follow',
    description: 'Set Session Follow for the authenticated Account.',
    safety: 'danger',
    safetyForInput: (input: unknown) => {
      const parsed = FollowReceiverRefV1Schema.safeParse((input as { receiver?: unknown } | null)?.receiver);
      return parsed.success && parsed.data.kind === 'account' ? 'safe' as const : 'danger' as const;
    },
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_set', voiceClientToolName: 'follow_set' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.set'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.set'],
    serverTransport: { method: 'PUT', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'follow.remove', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'receiver.sessionId', cardinality: 'one' },
    title: 'Remove Session Follow',
    description: 'Remove Session Follow for the authenticated Account.',
    safety: 'danger',
    safetyForInput: (input: unknown) => {
      const parsed = FollowReceiverRefV1Schema.safeParse((input as { receiver?: unknown } | null)?.receiver);
      return parsed.success && parsed.data.kind === 'account' ? 'safe' as const : 'danger' as const;
    },
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['follow', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'follow_remove', voiceClientToolName: 'follow_remove' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: SessionFollowActionInputSchemasV1['follow.remove'],
    outputSchema: SessionFollowActionOutputSchemasV1['follow.remove'],
    serverTransport: { method: 'DELETE', path: SESSION_FOLLOW_HTTP_PATHS_V1.follow },
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const SESSION_FOLLOW_RELATION_ACTION_SPECS: ReturnType<typeof createSessionFollowRelationActionSpecs> = lazyActionSpecArray(createSessionFollowRelationActionSpecs);

