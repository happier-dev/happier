import { MACHINE_ADD_SSH_ACTION_IDS, MACHINE_PAGE_ACTION_IDS } from './machineConnectionActionIdsV1.js';
export { MACHINE_ADD_SSH_ACTION_IDS, MACHINE_PAGE_ACTION_IDS, MACHINE_MANAGED_INSTALLATION_ACTION_IDS } from './machineConnectionActionIdsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { InstallableCapabilityIdSchema } from '../../installables/descriptor.js';
import { ManagedMachineBootstrapApprovalPromptV1Schema } from '../operations/v1.js';
import { redactObservationInputPaths } from './observationRedaction.js';
export { MachineTerminalOpenInputSchema, MachineTerminalListInputSchema } from './machineTerminal.js';

const id = z.string().check(z.trim(), z.minLength(1));
export type MachinePageActionId = typeof MACHINE_PAGE_ACTION_IDS[number];
const machineTarget = { serverId: z.optional(id), machineId: id };
export const MachineManagedInstallationRespondInputSchema = lazyZodSchema(() => {
  const correlation = { serverId: id, homeId: id, managedId: id, operationId: id, taskId: id };
  return z.discriminatedUnion('purpose', [
    z.strictObject({ ...correlation, purpose: z.literal('approve'),
      prompt: ManagedMachineBootstrapApprovalPromptV1Schema, approved: z.boolean() }),
    z.strictObject({ ...correlation, purpose: z.literal('establish'), promptId: id,
      password: z.string().check(z.minLength(1)) }),
  ]);
});
export const MachineMetadataUpdateInputSchema = lazyZodSchema(() => z.strictObject({
  ...machineTarget,
  expectedVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
  patch: z.strictObject({
    displayName: z.optional(z.nullable(z.string())),
    windowsRemoteSessionLaunchMode: z.optional(z.nullable(z.enum(['hidden', 'windows_terminal', 'console']))),
  }).check(z.refine(value => Object.keys(value).length > 0)),
}));
export const MachineStopDaemonInputSchema = lazyZodSchema(() => z.strictObject(machineTarget));
export const MachineRemoveInputSchema = lazyZodSchema(() => z.strictObject(machineTarget));
export const MachineCapabilityInstallInputSchema = lazyZodSchema(() => z.strictObject({
  ...machineTarget,
  capabilityId: InstallableCapabilityIdSchema,
  method: z.enum(['install', 'upgrade']),
}));
export const MachineCapabilityInstallOutputSchema = lazyZodSchema(() => z.discriminatedUnion('supported', [
  z.strictObject({ supported: z.literal(true), response: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), result: z.optional(StrictJsonValueSchema) }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ message: z.string(), code: z.optional(z.string()) }), logPath: z.optional(z.string()) }),
  ]) }),
  z.strictObject({ supported: z.literal(false), reason: z.enum(['not-supported', 'error']),
    requestDisposition: z.optional(z.enum(['notSent', 'outcomeUnknown'])) }),
]));
export const MachineReplacementSetInputSchema = lazyZodSchema(() => z.strictObject({
  ...machineTarget, replacementMachineId: id, confirmActiveOldMachine: z.optional(z.boolean()),
}));
export const MachineReplacementClearInputSchema = lazyZodSchema(() => z.strictObject(machineTarget));
export const MachineReplacementOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), status: z.number().check(z.int()), error: z.string() }),
]));
export const MACHINE_PAGE_ACTION_INPUT_SCHEMAS = {
  'machines.metadata.update': MachineMetadataUpdateInputSchema,
  'machines.daemon.stop': MachineStopDaemonInputSchema,
  'machines.remove': MachineRemoveInputSchema,
  'machines.capabilities.install': MachineCapabilityInstallInputSchema,
  'machines.replacement.set': MachineReplacementSetInputSchema,
  'machines.replacement.clear': MachineReplacementClearInputSchema,
} as const;
export const MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS = {
  'machines.metadata.update': lazyZodSchema(() => z.strictObject({ version: z.number().check(z.int(), z.nonnegative()) })),
  'machines.daemon.stop': lazyZodSchema(() => z.strictObject({ message: z.string() })),
  'machines.remove': lazyZodSchema(() => z.union([
    z.strictObject({ ok: z.literal(true), machineAlreadyRevoked: z.boolean(), providerCleanup: z.enum(['complete', 'not_needed']) }),
    z.strictObject({ ok: z.literal(false), status: z.number().check(z.int()), error: z.string(), machineRevoked: z.literal(true), providerCleanup: z.literal('pending'), retryable: z.boolean() }),
    z.strictObject({ ok: z.literal(false), status: z.number().check(z.int()), error: z.string() }),
  ])),
  'machines.capabilities.install': MachineCapabilityInstallOutputSchema,
  'machines.replacement.set': MachineReplacementOutputSchema,
  'machines.replacement.clear': MachineReplacementOutputSchema,
} as const;
export type MachinePageActionInput = z.infer<(typeof MACHINE_PAGE_ACTION_INPUT_SCHEMAS)[MachinePageActionId]>;
export const HomeReconnectInputSchema = lazyZodSchema(() => z.strictObject({ serverId: id }));
export const HomeReconnectOutputSchema = HomeReconnectInputSchema;
export const HomeConnectInputSchema = lazyZodSchema(() => z.strictObject({
  address: id,
  displayName: z.optional(id),
  acceptInsecureHttp: z._default(z.boolean(), false),
  acceptCanonicalUrl: z._default(z.boolean(), false),
}));
export const HomeConnectOutputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connected'), serverId: id, serverUrl: id, name: z.string() }),
  z.strictObject({ kind: z.literal('invalid_address') }),
  z.strictObject({ kind: z.literal('declined') }),
  z.strictObject({ kind: z.literal('mixed_content') }),
  z.strictObject({ kind: z.literal('unreachable') }),
]));
export const MachineAddCommandInputSchema = lazyZodSchema(() => z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('another_computer'), serverId: id, os: z.enum(['macos', 'linux', 'windows']) }),
  z.strictObject({ method: z.literal('ssh'), serverId: id, os: z.enum(['macos', 'linux', 'windows']),
    host: id, username: z.optional(z.string()), port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))),
    authMode: z._default(z.enum(['agent', 'keyfile', 'password']), 'agent'), identityFilePath: z.optional(z.string()),
  }),
]));
export const MachineAddCommandOutputSchema = lazyZodSchema(() => z.strictObject({ command: id, descriptorFileRequired: z.boolean() }));
export const MachinePairingCreateInputSchema = lazyZodSchema(() => z.strictObject({ serverId: id }));
export const MachineAddLocalStartInputSchema = lazyZodSchema(() => z.strictObject({ serverId: id, reconsiderCli: z.optional(z.boolean()) }));
export const MachinePairingCreateOutputSchema = lazyZodSchema(() => z.strictObject({ pairId: id, link: id, expiresAtMs: z.number().check(z.int(), z.nonnegative()) }));
export type MachineAddSshActionId = typeof MACHINE_ADD_SSH_ACTION_IDS[number];
export const MachineAddSshStartInputSchema = lazyZodSchema(() => z.union([z.strictObject({ serverId: id, host: id, username: z._default(z.string(), ''),
  port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))), authMode: z._default(z.enum(['agent', 'keyfile', 'password']), 'agent'),
  identityFilePath: z.optional(z.string()),
}), z.strictObject({ serverId: id, savedHostId: id,
  expectedHostRevision: z.union([z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)), z.literal('absent')]),
})]));
export const MachineAddSshTaskInputSchema = lazyZodSchema(() => z.strictObject({ taskId: id }));
export const MachineAddSshCancelInputSchema = lazyZodSchema(() => z.strictObject({ taskId: z.optional(id) }));
export const MachineAddSshAnswerSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ssh.password') }),
  z.strictObject({ kind: z.literal('ssh.trustHost'), trusted: z.boolean() }),
  z.strictObject({ kind: z.literal('ssh.replaceHostKey'), trusted: z.boolean() }),
  z.strictObject({ kind: z.literal('auth.approveRemoteProvisioning'), approved: z.boolean() }),
  z.strictObject({ kind: z.literal('daemon.replaceRemoteBackgroundServices'), replaceExistingServices: z.boolean() }),
  z.strictObject({ kind: z.literal('releaseChannel.switchDefaultForSetup'), switchDefaultReleaseChannel: z.boolean() }),
]));
export const MachineAddSshRespondInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineAddSshTaskInputSchema, { answer: MachineAddSshAnswerSchema })));
export const MachineAddSshTaskOutputSchema = lazyZodSchema(() => z.strictObject({ taskId: id }));
export const MachineAddSshCancelOutputSchema = lazyZodSchema(() => z.union([
  MachineAddSshTaskOutputSchema, z.strictObject({ pendingCanceled: z.literal(true) }),
]));
export const MachineAddSshStatusOutputSchema = lazyZodSchema(() => z.strictObject({ taskId: id, status: z.enum(['running', 'canceling', 'succeeded', 'failed', 'canceled']),
  currentStepId: z.nullable(z.string()), awaitingInput: z.boolean(),
  prompt: z.nullable(z.strictObject({ kind: id, message: z.string(), fingerprint: z.optional(z.string()), existingFingerprint: z.optional(z.nullable(z.string())),
    target: z.optional(z.string()), publicKey: z.optional(z.nullable(z.string())), requiresPresentUser: z.boolean() })),
  machineId: z.nullable(z.string()), errorCode: z.nullable(z.string()),
}));
export const MACHINE_ADD_SSH_INPUT_SCHEMAS = {
  'machines.add.ssh.start': MachineAddSshStartInputSchema, 'machines.add.ssh.status': MachineAddSshTaskInputSchema,
  'machines.add.ssh.respond': MachineAddSshRespondInputSchema, 'machines.add.ssh.cancel': MachineAddSshCancelInputSchema,
} as const;

const clientSurfaces = { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false } as const;
// SSH and setup-command Actions run in the client's SSH bridge / web command; the CLI adds Machines through its own native installer (58d §D3).
const setupClientSurfaces = { ...clientSurfaces, cli: false } as const;
export const MACHINE_CONNECTION_ACTION_SPECS = [
  {
    id: 'machines.metadata.update', approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'] }, approval: {result: 'required'}, title: 'Update machine details',
    description: 'Change the machine name or Windows session launch mode through versioned Machine metadata.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_metadata_update' },
    cli: { commands: [{ path: ['machines', 'metadata', 'update'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MACHINE_PAGE_ACTION_INPUT_SCHEMAS['machines.metadata.update'], outputSchema: MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.metadata.update'],
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'expectedVersion', title: 'Metadata version', widget: 'text' }, { path: 'patch', title: 'Changes', widget: 'json', required: true },
    ] },
  },
  {
    id: 'machines.daemon.stop', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'required'}, title: 'Stop machine daemon',
    description: 'Stop the daemon on this machine through its existing stop RPC.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_daemon_stop' },
    cli: { commands: [{ path: ['machines', 'daemon', 'stop'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MACHINE_PAGE_ACTION_INPUT_SCHEMAS['machines.daemon.stop'], outputSchema: MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.daemon.stop'],
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.remove', approval: {result: 'required'}, title: 'Remove machine',
    irreversible: true,
    description: 'Revoke the machine from its Home and clean up its Provider state.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_remove' },
    cli: { commands: [{ path: ['machines', 'remove'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MACHINE_PAGE_ACTION_INPUT_SCHEMAS['machines.remove'], outputSchema: MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.remove'],
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.capabilities.install', approval: {result: 'required'}, title: 'Install machine capability',
    description: 'Install, update, or reinstall one installable dependency through the machine daemon capability owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_capabilities_install' },
    cli: { commands: [{ path: ['machines', 'capabilities', 'install'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineCapabilityInstallInputSchema, outputSchema: MachineCapabilityInstallOutputSchema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'capabilityId', title: 'Installable capability ID', widget: 'text', required: true },
      { path: 'method', title: 'Install or upgrade', widget: 'select', required: true,
        options: [{ value: 'install', label: 'Install or reinstall' }, { value: 'upgrade', label: 'Upgrade' }] },
    ] },
  },
  {
    id: 'machines.replacement.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'required'}, title: 'Replace a machine',
    description: 'Mark a machine as replaced by another machine through its existing Home enrollment owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_replacement_set' },
    serverTransport: { method: 'POST', path: '/v1/machines/:machineId/replacement' },
    cli: { commands: [{ path: ['machines', 'replacement', 'set'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineReplacementSetInputSchema, outputSchema: MachineReplacementOutputSchema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'replacementMachineId', title: 'Replacement Machine ID', widget: 'text', required: true },
      { path: 'confirmActiveOldMachine', title: 'Confirm replacement of an active machine', widget: 'boolean' },
    ] },
  },
  {
    id: 'machines.replacement.clear', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'required'}, title: 'Undo machine replacement',
    description: 'Clear a machine replacement through the same Home enrollment owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_replacement_clear' },
    serverTransport: { method: 'DELETE', path: '/v1/machines/:machineId/replacement' },
    cli: { commands: [{ path: ['machines', 'replacement', 'clear'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineReplacementClearInputSchema, outputSchema: MachineReplacementOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.add.local.start', approval: { result: 'required' }, title: 'Set up this computer',
    description: 'Set up the answering desktop computer on its focused signed-in Home. Native setup inputs and Account-move consent remain private to that App.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: clientSurfaces, cli: { commands: [] },
    bindings: { mcpToolName: 'machines_add_local_start' },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineAddLocalStartInputSchema, outputSchema: MachineAddSshTaskOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'reconsiderCli', title: 'Ask who manages the command line again', widget: 'boolean' }] },
  },
  {
    id: 'machines.add.ssh.start', approval: {result: 'required'}, title: 'Add machine over SSH',
    description: 'Start SSH setup on the focused signed-in Home using a target or saved host. Credentials stay in private task custody or are resolved from the captured saved host; they are never Action arguments.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: setupClientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_start' }, inputSchema: MachineAddSshStartInputSchema, outputSchema: MachineAddSshTaskOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true }, { path: 'host', title: 'SSH host', widget: 'text' },
      { path: 'savedHostId', title: 'Saved host ID', widget: 'text' }, { path: 'expectedHostRevision', title: 'Saved host catalog revision', widget: 'text' },
      { path: 'username', title: 'SSH user', widget: 'text' }, { path: 'port', title: 'SSH port', widget: 'text' }, { path: 'authMode', title: 'Authentication', widget: 'text' },
      { path: 'identityFilePath', title: 'Identity file', widget: 'text' }] },
  },
  {
    id: 'machines.add.ssh.status', approval: {result: 'required'}, title: 'Read SSH machine setup', description: 'Read the retained SSH setup task and its current prompt. Task success is not proof of Home feed arrival.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [], surfaces: setupClientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_status' }, inputSchema: MachineAddSshTaskInputSchema, outputSchema: MachineAddSshStatusOutputSchema,
    inputHints: { fields: [{ path: 'taskId', title: 'Task ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.add.ssh.respond', approval: {result: 'required'}, title: 'Answer SSH setup prompt', description: 'Answer the exact current SSH setup prompt; trust and service changes are never accepted implicitly.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: setupClientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_respond' }, inputSchema: MachineAddSshRespondInputSchema, outputSchema: MachineAddSshTaskOutputSchema,
    inputHints: { fields: [{ path: 'taskId', title: 'Task ID', widget: 'text', required: true }, { path: 'answer', title: 'Prompt answer', widget: 'json', required: true }] },
  },
  {
    id: 'machines.add.ssh.cancel', approval: {result: 'required'}, title: 'Cancel SSH machine setup', description: 'Cancel the retained SSH task through its existing system-task owner. Omit taskId to cancel its pending native start.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: setupClientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_cancel' }, inputSchema: MachineAddSshCancelInputSchema, outputSchema: MachineAddSshCancelOutputSchema,
    inputHints: { fields: [{ path: 'taskId', title: 'Task ID', widget: 'text' }] },
  },
  {
    id: 'homes.reconnect', approval: { result: 'required' }, title: 'Retry the focused Home connection',
    description: 'Retry the current Home through its existing connection recovery owner. This does not switch device focus to another Home.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: clientSurfaces, cli: { commands: [] },
    bindings: { mcpToolName: 'homes_reconnect' }, inputSchema: HomeReconnectInputSchema, outputSchema: HomeReconnectOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Focused Home ID', widget: 'text', required: true }] },
  },
  {
    id: 'homes.connect', approval: { result: 'required' }, title: 'Connect a Home by address',
    description: 'Check and save a Home address, returning the canonical connection outcome. Device focus stays with the current Home.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: clientSurfaces, cli: { commands: [] },
    bindings: { mcpToolName: 'homes_connect' }, inputSchema: HomeConnectInputSchema, outputSchema: HomeConnectOutputSchema,
    inputHints: { fields: [{ path: 'address', title: 'Home address', widget: 'text', required: true },
      { path: 'displayName', title: 'Home name', widget: 'text' },
      { path: 'acceptInsecureHttp', title: 'Accept insecure HTTP', widget: 'boolean' },
      { path: 'acceptCanonicalUrl', title: 'Use the advertised canonical address', widget: 'boolean' }] },
  },
  {
    id: 'machines.add.command', approval: {result: 'required'}, title: 'Prepare machine setup command',
    description: 'Get the existing SSH or another-computer setup command for a saved Home. This does not install or connect the machine.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [], surfaces: setupClientSurfaces,
    bindings: { mcpToolName: 'machines_add_command' }, inputSchema: MachineAddCommandInputSchema, outputSchema: MachineAddCommandOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'method', title: 'Setup method', widget: 'select', required: true, options: [{ value: 'another_computer', label: 'Another computer' }, { value: 'ssh', label: 'SSH' }] },
      { path: 'os', title: 'Operating system', widget: 'select', required: true, options: [{ value: 'macos', label: 'macOS' }, { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }] },
      { path: 'host', title: 'SSH host', widget: 'text' }, { path: 'username', title: 'SSH user', widget: 'text' },
      { path: 'port', title: 'SSH port', widget: 'text' }, { path: 'authMode', title: 'SSH authentication', widget: 'text' }, { path: 'identityFilePath', title: 'Identity file', widget: 'text' }] },
  },
  {
    id: 'machines.pairing.create', approval: {result: 'required'}, title: 'Create link to add another computer',
    description: 'Issue a short-lived Home pairing link through the trusted device enrollment lifecycle. Keep this client running until the computer joins.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: clientSurfaces, cli: { commands: [] },
    bindings: { mcpToolName: 'machines_pairing_create' }, inputSchema: MachinePairingCreateInputSchema, outputSchema: MachinePairingCreateOutputSchema,
    projectObservationOutput: () => ({ redacted: true }),
    approvalResultCustody: 'live_only',
    inputHints: { description: 'Make a link that adds another computer to a Home. It works for a short time; keep this device open until the computer has joined.',
      fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.managed.bootstrap.respond', approval: { result: 'required' }, title: 'Answer managed machine installation prompt',
    description: 'Answer the current installation question for one managed machine through an answering client. The current resource, controller, task and exact question are rechecked before delivery.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: clientSurfaces, cli: { commands: [] },
    bindings: { mcpToolName: 'machines_managed_bootstrap_respond' },
    inputSchema: MachineManagedInstallationRespondInputSchema, outputSchema: MachineAddSshTaskOutputSchema,
    approvalInputCustody: 'live_only', projectObservationInput: redactObservationInputPaths('password'),
    inputHints: { fields: [
      { path: 'serverId', title: 'Home profile', widget: 'text', required: true },
      { path: 'homeId', title: 'Home identity', widget: 'text', required: true },
      { path: 'managedId', title: 'Managed machine ID', widget: 'text', required: true },
      { path: 'operationId', title: 'Creation operation ID', widget: 'text', required: true },
      { path: 'taskId', title: 'Installation task ID', widget: 'text', required: true },
      { path: 'purpose', title: 'Response purpose', widget: 'select', required: true,
        options: [{ value: 'approve', label: 'Approve installation step' }, { value: 'establish', label: 'Establish administrator' }] },
      { path: 'prompt', title: 'Current installation question', widget: 'json', required: true,
        visibleWhen: { op: 'eq', path: 'purpose', value: 'approve' } },
      { path: 'approved', title: 'Approve this installation step', widget: 'boolean', required: true,
        visibleWhen: { op: 'eq', path: 'purpose', value: 'approve' } },
      { path: 'promptId', title: 'Current administrator prompt', widget: 'text', required: true,
        visibleWhen: { op: 'eq', path: 'purpose', value: 'establish' } },
      { path: 'password', title: 'New administrator password', widget: 'secret', required: true,
        visibleWhen: { op: 'eq', path: 'purpose', value: 'establish' } },
    ] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
