import { PLUGIN_PERMISSION_INPUT_FIELDS } from './pluginPermissionsInputHints.js';
import type { ActionSurfaceBindingContext, PreNormalizedActionSpec } from './definition.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { PluginPermissionGrantActionInputSchemasV1, PluginPermissionGrantActionOutputSchemasV1, type PluginPermissionGrantActionIdV1 } from '../../plugins/permissions/actions.js';
import { PluginPermissionSubjectV1Schema } from '../../plugins/permissions/grants.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';


export const PLUGIN_PERMISSION_GRANT_ACTION_TITLES: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': 'List plugin permission grants',
  'plugins.permissions.grants.request': 'Request plugin permission grant',
  'plugins.permissions.grants.grant': 'Grant plugin permission',
  'plugins.permissions.grants.revoke': 'Revoke plugin permission',
  'plugins.permissions.grants.dismissRequest': 'Dismiss plugin permission request',
});

export const PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_LIST,
  'plugins.permissions.grants.request': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REQUEST,
  'plugins.permissions.grants.grant': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_GRANT,
  'plugins.permissions.grants.revoke': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_REVOKE,
  'plugins.permissions.grants.dismissRequest': RPC_METHODS.PLUGIN_PERMISSION_GRANTS_DISMISS_REQUEST,
});

export const PluginPermissionSubjectPluginInputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginPermissionSubjectV1Schema._zod.def.options[0],
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PluginPermissionSubjectV1Schema._zod.def.options[1], { contribution: true }), {
    contribution: z.strictObject({ localId: asProtocolZod(PluginContributionLocalIdSchema) }),
  })),
]));
export const PluginPermissionGrantListPluginInputSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.list'], { pluginId: true, grantId: true, subject: true }), { subject: z.optional(PluginPermissionSubjectPluginInputSchema) })));
export const PluginPermissionGrantRequestPluginInputSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.request'], {
    pluginId: true,
    requester: true,
    subject: true,
  }), { subject: PluginPermissionSubjectPluginInputSchema })));
export const PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS = Object.freeze({
  'plugins.permissions.grants.list': PluginPermissionGrantListPluginInputSchema,
  'plugins.permissions.grants.request': PluginPermissionGrantRequestPluginInputSchema,
  'plugins.permissions.grants.revoke': PluginPermissionGrantActionInputSchemasV1['plugins.permissions.grants.revoke'],
});

export function requirePluginBindingCaller(context: ActionSurfaceBindingContext): Readonly<{
  kind: 'plugin';
  pluginId: string;
}> {
  if (context.caller.kind !== 'plugin') {
    throw new Error('plugin_surface_caller_required');
  }
  return context.caller;
}

export function bindPluginPermissionSubject(
  subject: z.infer<typeof PluginPermissionSubjectPluginInputSchema> | undefined,
  pluginId: string,
): unknown {
  if (!subject || subject.kind === 'general') return subject;
  return {
    ...subject,
    contribution: {
      pluginId,
      localId: subject.contribution.localId,
    },
  };
}

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
export const PLUGIN_PERMISSION_GRANT_ACTION_SUMMARIES: Readonly<Record<PluginPermissionGrantActionIdV1, string>> = Object.freeze({
  'plugins.permissions.grants.list': 'See which optional permissions you have given your plugins.',
  'plugins.permissions.grants.request': 'Have a plugin ask you for an optional permission. Nothing is allowed until you say yes.',
  'plugins.permissions.grants.grant': 'Give a plugin an optional permission it asked for.',
  'plugins.permissions.grants.revoke': 'Take back an optional permission you gave a plugin.',
  'plugins.permissions.grants.dismissRequest': 'Close a plugin\'s permission request without allowing it.',
});

export function createPluginPermissionGrantActionSpec(actionId: PluginPermissionGrantActionIdV1): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.permissions.grants.list';
  const isRevoke = actionId === 'plugins.permissions.grants.revoke';
  const pluginBinding = actionId === 'plugins.permissions.grants.list'
    ? {
        inputSchema: PluginPermissionGrantListPluginInputSchema,
        bindInput(value: unknown, context: ActionSurfaceBindingContext) {
          const caller = requirePluginBindingCaller(context);
          const input = value as z.infer<typeof PluginPermissionGrantListPluginInputSchema>;
          return {
            ...input,
            pluginId: caller.pluginId,
            ...(input.subject
              ? { subject: bindPluginPermissionSubject(input.subject, caller.pluginId) }
              : {}),
          };
        },
      }
    : actionId === 'plugins.permissions.grants.request'
      ? {
          inputSchema: PluginPermissionGrantRequestPluginInputSchema,
          bindInput(value: unknown, context: ActionSurfaceBindingContext) {
            const caller = requirePluginBindingCaller(context);
            const input = value as z.infer<typeof PluginPermissionGrantRequestPluginInputSchema>;
            return {
              ...input,
              pluginId: caller.pluginId,
              subject: bindPluginPermissionSubject(input.subject, caller.pluginId),
              requester: {
                kind: 'plugin' as const,
                pluginId: caller.pluginId,
                ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
              },
            };
          },
        }
      : actionId === 'plugins.permissions.grants.revoke'
        ? {
            inputSchema: PLUGIN_PERMISSION_GRANT_PLUGIN_INPUT_SCHEMAS[actionId],
          }
        : undefined;
  return {
    id: actionId, executionPlacement: 'account', approval: isRead ? { result: 'required' }
      : isRevoke ? { result: 'optional', flow: 'deferred' } : { result: 'none' },
    title: PLUGIN_PERMISSION_GRANT_ACTION_TITLES[actionId],
    description: 'Manage durable user-approved optional plugin permission grants.',
    safety: isRead ? 'safe' : 'danger',
    placements: [],
    bindings: {
      rpcMethod: PLUGIN_PERMISSION_GRANT_ACTION_RPC_METHODS[actionId],
      sdkMethod: actionId,
    },
    ...(pluginBinding ? { surfaceBindings: { plugin: pluginBinding } } : {}),
    surfaces: {
      ui: true,
      voice: false,
      agent: isRead || isRevoke,
      mcp: isRead || isRevoke,
      cli: isRead || isRevoke,
      rpc: true,
    },
    ...(isRead || isRevoke ? { cli: { commands: [] } } : {}),
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginPermissionGrantActionOutputSchemasV1[actionId],
    inputSchema: PluginPermissionGrantActionInputSchemasV1[actionId],
    inputHints: { description: PLUGIN_PERMISSION_GRANT_ACTION_SUMMARIES[actionId], fields: PLUGIN_PERMISSION_INPUT_FIELDS[actionId] ?? [] },
  };
}
