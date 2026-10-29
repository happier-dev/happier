import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PetChooseInputV1Schema, PetChooseResultV1Schema } from '../../pets/selection.js';
import { AccountHomeContinuationInputV1Schema, AccountHomeContinuationResultV1Schema } from '../accountHomeContinuationV1.js';
import { z } from 'zod/mini';
import { CurrentUiContextSnapshotV1Schema } from '../../plugins/ui/currentUiContext.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { EmptyObjectSchema, OptionalSessionIdInputSchema } from './common.js';
import type { PreNormalizedActionSpec } from './definition.js';


/** Current-UI semantic payloads stay behind the ephemeral opaque command handle. */
export const CurrentUiContextCommandInvokeInputSchema = lazyZodSchema(() => z.strictObject({
  commandId: z.string().check(z.trim(), z.minLength(1)),
}));

export const UI_CONTEXT_ACTION_SPECS = Object.freeze([
  {
    id: 'ui.voice_global.reset', approval: {result: 'none'},
    title: 'Reset voice agent',
    sideEffectClass: 'write',
    safety: 'danger',
    executionPlacement: 'client',
    requiredAuthority: 'account_automation',
    placements: ['voice_panel', 'command_palette', 'slash_command'],
    slash: { tokens: ['/h.voice.reset'] },
    bindings: { voiceClientToolName: 'resetGlobalVoiceAgent', mcpToolName: 'ui_voice_global_reset' },
    inputHints: {
      title: 'Reset voice agent',
      description: 'Reset the global voice agent state (clears the current voice conversation).',
      fields: [],
    },
    examples: {
      voice: { argsExample: '{}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: EmptyObjectSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'ui.pet.choose', approval: { result: 'optional', flow: 'deferred' },
    title: 'Choose pet',
    description: 'Choose an Account pet and inherit it on this device, set a device pet override, or open pet settings with empty input.',
    safety: 'safe',
    sideEffectClass: 'write',
    executionPlacement: 'client',
    requiredAuthority: 'account_automation',
    bindings: { mcpToolName: 'ui_pet_choose' },
    placements: ['slash_command'],
    slash: { tokens: ['/pet', '/h.pet'] },
    inputHints: {
      title: 'Choose pet',
      description: 'Provide petRef for the Account default or deviceOverride for this answering device. Empty input opens pet settings.',
      fields: [],
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    outputSchema: PetChooseResultV1Schema,
    inputSchema: PetChooseInputV1Schema,
    // Empty input is the chooser navigation; a typed selection reads from the spec description.
    approvalPresentation: { summary: (input: unknown) => (
      input !== null && typeof input === 'object' && Object.keys(input).length === 0 ? 'Open pet settings.' : null
    ) },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'ui.voice_agent.teleport', executionPlacement: 'client', approval: {result: 'optional',flow: 'deferred'},
    title: 'Teleport voice agent to session root',
    sideEffectClass: 'write',
    description: 'Move the daemon-backed voice agent into the current or specified session root.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'teleportVoiceAgentToSessionRoot', mcpToolName: 'ui_voice_agent_teleport' },
    inputHints: {
      title: 'Teleport voice agent',
      description: 'Teleport the active voice agent into a session root. Defaults to the current action session when omitted.',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' }],
    },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: OptionalSessionIdInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'ui.current_context.read', executionPlacement: 'client', approval: {result: 'required'},
    title: 'Read current UI context',
    description: 'Read the current local UI navigation context and its complete opaque command inventory.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'readCurrentUiContext', mcpToolName: 'read_current_ui_context' },
    cli: { commands: [{ path: ['ui', 'current-context', 'read'], visibility: 'canonical' }], acceptsServerId: true },
    examples: {
      voice: { argsExample: '{}' },
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
      title: 'Read current UI context',
      description: 'Returns only the current local navigation snapshot and opaque command descriptors.',
      fields: [],
    },
    outputSchema: CurrentUiContextSnapshotV1Schema,
    inputSchema: EmptyObjectSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.home_continuation.invoke', executionPlacement: 'client', approval: {result: 'required'},
    title: 'Continue Home connection',
    description: 'Request an exact mounted authenticated Account continuation: choose a Home, retry, refresh, stop waiting, relink or open the enrolled Home. A human in that Account decides; key, credential and QR acquisition remain human-only.',
    requiredAuthority: 'present_user', safety: 'safe', sideEffectClass: 'write', placements: [],
    bindings: { mcpToolName: 'account_home_continuation_invoke' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputHints: { title: 'Continue Home connection', fields: [
      { path: 'operation', title: 'Continuation step', widget: 'text', required: true },
      { path: 'commandId', title: 'Current mounted command', widget: 'text', required: true },
      { path: 'homeServerIdentityId', title: 'Chosen Home identity (choose only)', widget: 'text' },
    ] },
    inputSchema: AccountHomeContinuationInputV1Schema,
    outputSchema: AccountHomeContinuationResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'ui.current_context.command.invoke', executionPlacement: 'client', approval: {result: 'required'},
    title: 'Invoke current UI command',
    description: 'Invoke one currently available opaque command from the local current UI context. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'invokeCurrentUiCommand', mcpToolName: 'invoke_current_ui_command' },
    cli: { commands: [{ path: ['ui', 'current-context', 'command', 'invoke'], positionals: ['commandId'], visibility: 'canonical' }], acceptsServerId: true },
    examples: {
      voice: { argsExample: '{"commandId":"current-ui:1:0"}' },
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
      title: 'Invoke current UI command',
      description: 'Use only an opaque command id returned by readCurrentUiContext; semantic command data is never accepted here.',
      fields: [
        { path: 'commandId', title: 'Opaque command id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: CurrentUiContextCommandInvokeInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

