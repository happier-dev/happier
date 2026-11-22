import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1, LOCAL_DAEMON_SERVICE_ACTION_IDS } from './localDaemonServiceActionIdsV1.js';
export { LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1, LOCAL_DAEMON_SERVICE_ACTION_IDS } from './localDaemonServiceActionIdsV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SystemTaskResultSchema } from '../../system/tasks/spec.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
export type LocalDaemonServiceActionId = typeof LOCAL_DAEMON_SERVICE_ACTION_IDS[number];
export const LocalDaemonServiceInputSchema = lazyZodSchema(() => z.strictObject({ serverId: z.string().check(z.trim(), z.minLength(1)) }));
export const LocalDaemonServiceAutostartInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(LocalDaemonServiceInputSchema, { autostart: z.enum(['at-login', 'on-demand']) })));
export const LocalCliPathExposureSetInputSchema = lazyZodSchema(() => z.strictObject({
  ...LocalDaemonServiceInputSchema.shape, enabled: z.boolean(),
}));
export const LocalDaemonServiceOutputSchema = lazyZodSchema(() => z.strictObject({ taskId: z.string().check(z.minLength(1)), result: SystemTaskResultSchema }));
export const LocalDaemonServiceDisconnectOutputSchema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.enum(['removed', 'no_service']) }),
  z.strictObject({ outcome: z.literal('user_owned'), label: z.nullable(z.string()) }),
]));
export const LOCAL_DAEMON_SERVICE_INPUT_SCHEMAS = {
  'machines.local.service.status': LocalDaemonServiceInputSchema,
  'machines.local.service.start': LocalDaemonServiceInputSchema,
  'machines.local.service.stop': LocalDaemonServiceInputSchema,
  'machines.local.service.restart': LocalDaemonServiceInputSchema,
  'machines.local.service.autostart.set': LocalDaemonServiceAutostartInputSchema,
  'machines.local.service.update': LocalDaemonServiceInputSchema,
  'machines.local.service.disconnect': LocalDaemonServiceInputSchema,
  [LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1]: LocalCliPathExposureSetInputSchema,
} as const;
const surfaces = { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false } as const;
const clientCli = { commands: [] };
const common = { executionPlacement: 'client', placements: [], surfaces, cli: clientCli, approval: { result: 'required' },
  inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true }] } } as const;
function createLocalDaemonServiceActionSpecs() {
  return [
  { ...common, id: 'machines.local.service.status', title: 'Read local background service', description: 'Read the native user service for this Home on the invoking desktop.', safety: 'safe', sideEffectClass: 'read', bindings: { mcpToolName: 'machines_local_service_status' }, inputSchema: LocalDaemonServiceInputSchema, outputSchema: LocalDaemonServiceOutputSchema },
  { ...common, id: 'machines.local.service.start', title: 'Start local background service', description: 'Start the existing native user service for this Home.', safety: 'safe', sideEffectClass: 'write', bindings: { mcpToolName: 'machines_local_service_start' }, inputSchema: LocalDaemonServiceInputSchema, outputSchema: LocalDaemonServiceOutputSchema },
  { ...common, id: 'machines.local.service.stop', title: 'Stop local background service', description: 'Stop the native user service for this Home; this can interrupt its sessions.', safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'machines_local_service_stop' }, inputSchema: LocalDaemonServiceInputSchema, outputSchema: LocalDaemonServiceOutputSchema },
  { ...common, id: 'machines.local.service.restart', title: 'Restart local background service', description: 'Restart the native user service for this Home; this can interrupt its sessions.', safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'machines_local_service_restart' }, inputSchema: LocalDaemonServiceInputSchema, outputSchema: LocalDaemonServiceOutputSchema },
  { ...common, id: 'machines.local.service.autostart.set', title: 'Set desktop login start', description: 'Set the common login-start mode of every desktop-managed service, not a stored preference.', safety: 'safe', sideEffectClass: 'write', bindings: { mcpToolName: 'machines_local_service_autostart_set' }, inputSchema: LocalDaemonServiceAutostartInputSchema, outputSchema: LocalDaemonServiceOutputSchema, inputHints: { fields: [...common.inputHints.fields, { path: 'autostart', title: 'Login-start mode', widget: 'text', required: true }] } },
  { ...common, id: 'machines.local.service.update', title: 'Update desktop-managed CLI', description: 'Use the shared managed-CLI update task and its scoped completion/readback.', safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'machines_local_service_update' }, inputSchema: LocalDaemonServiceInputSchema, outputSchema: LocalDaemonServiceOutputSchema },
  { ...common, id: 'machines.local.service.disconnect', title: 'Disconnect local service from Home', description: 'Remove only the desktop-managed service for this Home. Preserve user-owned services and the saved Home profile.', safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'machines_local_service_disconnect' }, inputSchema: LocalDaemonServiceInputSchema, outputSchema: LocalDaemonServiceDisconnectOutputSchema },
  { ...common, id: LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1,
    title: 'Set Happier CLI PATH exposure',
    description: 'Add the Happier CLI to PATH on the answering desktop or remove the entry the desktop created. Pass clientId to address a specific desktop client.',
    safety: 'danger', sideEffectClass: 'write', bindings: { mcpToolName: 'machines_local_service_path_exposure_set' },
    approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: LocalCliPathExposureSetInputSchema, outputSchema: LocalDaemonServiceOutputSchema,
    inputHints: { fields: [...common.inputHints.fields, { path: 'enabled', title: 'Add Happier CLI to PATH', widget: 'boolean', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const LOCAL_DAEMON_SERVICE_ACTION_SPECS: ReturnType<typeof createLocalDaemonServiceActionSpecs> = lazyActionSpecArray(createLocalDaemonServiceActionSpecs);
