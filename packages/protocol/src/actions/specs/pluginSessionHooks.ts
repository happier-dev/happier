import { PLUGIN_SESSION_HOOK_STATUS_INPUT_FIELDS, PLUGIN_SESSION_HOOK_INSTALL_INPUT_FIELDS, PLUGIN_SESSION_HOOK_MUTATION_INPUT_FIELDS } from './pluginSessionHookInputHints.js';
import { requirePluginBindingCaller } from './pluginPermissions.js';
import type { ActionSurfaceBindingContext, PreNormalizedActionSpec } from './definition.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT, PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS, PluginSessionHookInstallActionInputV1Schema, PluginSessionHookInstallInputV1Schema, PluginSessionHookInstallResponseV1Schema, PluginSessionHookInstallationMutationActionInputV1Schema, PluginSessionHookInstallationMutationInputV1Schema, PluginSessionHookStatusActionInputV1Schema, PluginSessionHookStatusInputV1Schema, PluginSessionHookStatusResponseV1Schema, PluginSessionHookToggleResponseV1Schema, PluginSessionHookUninstallResponseV1Schema } from '../../sessions/external/hookManagementV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';


export const PluginSessionHookAgentPluginInputSchema = lazyZodSchema(() => z.strictObject({
  localId: asProtocolZod(PluginContributionLocalIdSchema),
}));
export const PluginSessionHookStatusPluginInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('intent', [
  z.strictObject({
    intent: z.literal('passive_inventory'),
    agent: z.optional(PluginSessionHookAgentPluginInputSchema),
    cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(4_096))),
    limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_ROWS)), PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT),
  }),
  z.strictObject({
    intent: z.literal('install_preview'),
    agent: PluginSessionHookAgentPluginInputSchema,
  }),
  z.strictObject({
    intent: z.literal('installation_recheck'),
    agent: PluginSessionHookAgentPluginInputSchema,
    installationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  }),
]));
export const PluginSessionHookInstallPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  agent: PluginSessionHookAgentPluginInputSchema,
  expectedPreviewId: z.string().check(z.regex(/^hook-install-preview:v1:[0-9a-f]{64}$/u)),
}));
export const PluginSessionHookMutationPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  agent: PluginSessionHookAgentPluginInputSchema,
  installationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
}));

export function bindPluginSessionHookAgent(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const input = z.looseObject({
    agent: z.optional(PluginSessionHookAgentPluginInputSchema),
  }).parse(value);
  return {
    ...input,
    ...(input.agent
      ? { agent: { pluginId: caller.pluginId, localId: input.agent.localId } }
      : {}),
  };
}

export function projectPluginSessionHookStatus(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  const caller = requirePluginBindingCaller(context);
  const response = PluginSessionHookStatusResponseV1Schema.parse(value);
  return response.ok
    ? {
        ...response,
        rows: response.rows.filter((row) => row.agent.pluginId === caller.pluginId),
      }
    : response;
}

export const PluginSessionHookRpcSurfaceBinding = {
  inputSchema: PluginSessionHookStatusInputV1Schema,
  decodeInput: (value: unknown) => value,
  outputSchema: PluginSessionHookStatusResponseV1Schema,
  encodeOutput: (value: unknown) => value,
} as const;

export const PLUGIN_SESSION_HOOK_MANAGEMENT_ACTION_SPECS_V1 = [
  {
    id: 'plugins.sessionHooks.status.get', executionPlacement: 'machine', cli: { commands: [] }, approval: {result: 'required'},
    title: 'Get Agent session-hook status inventory',
    description:
      'Read a bounded, paginated inventory of portable External Session hook installation status rows.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET },
    surfaceBindings: {
      rpc: PluginSessionHookRpcSurfaceBinding,
      plugin: {
        inputSchema: PluginSessionHookStatusPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
        projectOutput: projectPluginSessionHookStatus,
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
    sideEffectClass: 'read',
    outputSchema: PluginSessionHookStatusResponseV1Schema,
    inputSchema: PluginSessionHookStatusActionInputV1Schema,
    inputHints: { fields: PLUGIN_SESSION_HOOK_STATUS_INPUT_FIELDS },
  },
  {
    id: 'plugins.sessionHooks.install', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    cli: { commands: [{ path: ['plugins', 'session-hooks', 'install'], visibility: 'canonical' }] },
    confirmVerb: { key: 'common.install', fallback: 'Install' },
    approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Install Agent session hooks',
    description: 'Explicitly install External Session hooks for one qualified Agent integration.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookInstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookInstallPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookInstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallActionInputV1Schema,
    inputHints: { fields: PLUGIN_SESSION_HOOK_INSTALL_INPUT_FIELDS },
  },
  {
    id: 'plugins.sessionHooks.disable', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    cli: { commands: [{ path: ['plugins', 'session-hooks', 'disable'], visibility: 'canonical' }] },
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Disable Agent session hooks',
    description: 'Explicitly disable ingestion for one exact Agent hook installation without deleting its owned config.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: PLUGIN_SESSION_HOOK_MUTATION_INPUT_FIELDS },
  },
  {
    id: 'plugins.sessionHooks.enable', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    cli: { commands: [{ path: ['plugins', 'session-hooks', 'enable'], visibility: 'canonical' }] },
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Enable Agent session hooks',
    description: 'Explicitly enable ingestion for one exact Agent hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookToggleResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'write',
    outputSchema: PluginSessionHookToggleResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: PLUGIN_SESSION_HOOK_MUTATION_INPUT_FIELDS },
  },
  {
    id: 'plugins.sessionHooks.uninstall', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    cli: { commands: [{ path: ['plugins', 'session-hooks', 'uninstall'], visibility: 'canonical' }] },
    confirmVerb: { key: 'settingsPlugins.uninstall', fallback: 'Uninstall' },
    approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Uninstall Agent session hooks',
    description: 'Explicitly remove only the owned entries for one exact External Session hook installation.',
    safety: 'danger',
    placements: [],
    bindings: { rpcMethod: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL },
    surfaceBindings: {
      rpc: {
        inputSchema: PluginSessionHookInstallationMutationInputV1Schema,
        decodeInput: (value: unknown) => value,
        outputSchema: PluginSessionHookUninstallResponseV1Schema,
        encodeOutput: (value: unknown) => value,
      },
      plugin: {
        inputSchema: PluginSessionHookMutationPluginInputV1Schema,
        bindInput: bindPluginSessionHookAgent,
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: true,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginSessionHookUninstallResponseV1Schema,
    inputSchema: PluginSessionHookInstallationMutationActionInputV1Schema,
    inputHints: { fields: PLUGIN_SESSION_HOOK_MUTATION_INPUT_FIELDS },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
