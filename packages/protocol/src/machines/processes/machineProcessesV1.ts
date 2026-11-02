import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DaemonLocalServiceLauncherStartRequestV1Schema, DaemonLocalServiceLauncherStartResponseV1Schema } from '../../local/services/launcher/v1.js';

// New Machine Processes wire epoch V1. Process envelopes and identity/ownership
// facts are closed. The optional launcher review uses its existing canonical
// schema, including its explicitly declared strict-JSON effect payload.
const id = () => z.string().check(z.minLength(1));
const bytes = () => z.number().check(z.nonnegative());
const target = () => ({ serverId: z.optional(id()), machineId: id() });
export const ProcessOwnerRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: id() }),
  z.strictObject({ kind: z.literal('terminal'), terminalId: id(), sessionId: z.optional(id()) }),
  z.strictObject({ kind: z.literal('service'), serviceId: id(), pluginId: z.optional(id()), sessionId: z.optional(id()), workspaceId: z.optional(id()) }),
  // Native lifecycle custody, not a spawned-process marker or requester identity.
  z.strictObject({ kind: z.literal('container'), serverId: id(), machineId: id(), serviceId: id(),
    containerId: z.string().check(z.regex(/^[a-f0-9]{64}$/u)), composeProject: id(), composeService: id(), environmentId: z.optional(id()) }),
  z.strictObject({ kind: z.literal('run'), runId: id(), sessionId: z.optional(id()) }),
  z.strictObject({ kind: z.literal('browser_sidecar') }),
  z.strictObject({ kind: z.literal('workspace_sync') }),
  z.strictObject({ kind: z.literal('happier'), component: z.optional(z.enum(['voice_worker', 'device_helper', 'recording_encoder', 'plugin_database_worker', 'workspace_sync'])) }),
]));
export type ProcessOwnerRefV1 = z.infer<typeof ProcessOwnerRefV1Schema>;
export const ProcessOwnershipLevelV1Schema = lazyZodSchema(() => z.enum(['proven', 'likely', 'left_behind', 'not_happier', 'unknown']));
export type ProcessOwnershipLevelV1 = z.infer<typeof ProcessOwnershipLevelV1Schema>;
export const ProcessEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['fence', 'parent_chain', 'marker', 'group_and_port']),
  state: z.enum(['met', 'not_met', 'not_available']),
  reason: z.enum(['linux_scope', 'windows_job', 'macos_no_fence', 'no_systemd_user_manager', 'job_join_failed',
    'outside_fence', 'live_root_chain', 'chain_broken_at_exit', 'no_live_root', 'marker_matches', 'marker_cleared',
    'foreign_home_marker', 'marker_owner_unknown', 'marker_predates_owner', 'same_group_port_opened_while_running',
    'no_group_or_port_match', 'principal_unreadable', 'other_principal', 'required_fields_unreadable']),
  at: z.optional(z.strictObject({ pid: z.number().check(z.int(), z.positive()), exitedAtMs: z.optional(bytes()) })),
}));
export type ProcessEvidenceV1 = z.infer<typeof ProcessEvidenceV1Schema>;
export const MachineProcessesTotalsV1Schema = lazyZodSchema(() => z.strictObject({
  memoryBytes: z.nullable(bytes()), cpuPercent: z.optional(bytes().check(z.maximum(100))), processCount: z.number().check(z.int(), z.nonnegative()),
}));
export type MachineProcessesTotalsV1 = z.infer<typeof MachineProcessesTotalsV1Schema>;
export const ProcessSampleV1Schema = lazyZodSchema(() => z.strictObject({
  capturedAtMs: bytes(), memoryBytes: z.nullable(bytes()), cpuPercent: z.optional(z.nullable(bytes().check(z.maximum(100)))),
}));
export type ProcessSampleV1 = z.infer<typeof ProcessSampleV1Schema>;
/** The approved detail chart window, not a sample-count limit; the daemon retains and the client keeps this much history. */
export const MACHINE_PROCESS_HISTORY_WINDOW_MS = 60 * 60_000;
export const ProcessRowV1Schema = lazyZodSchema(() => z.strictObject({
  rowId: id(), ref: id(), parentRowId: z.optional(id()), name: id(), displayName: z.optional(id()),
  role: z.optional(z.enum(['agent', 'tool_shell', 'test_runner', 'type_checker', 'dev_server', 'language_server', 'mcp_server', 'browser', 'database'])),
  browserEngine: z.optional(z.enum(['chromium', 'firefox', 'webkit'])), browserHelper: z.optional(z.boolean()),
  driverLabel: z.optional(z.string()),
  // Presentation only: child refs retain individual identity/Action semantics.
  browserGroup: z.optional(z.strictObject({ memberRefs: z.array(id()), totals: MachineProcessesTotalsV1Schema })),
  command: z.optional(z.string()), cwd: z.optional(z.string()), pid: z.number().check(z.int(), z.positive()), startedAtMs: bytes(),
  memoryBytes: z.nullable(bytes()), memoryKind: z.nullable(z.enum(['rss', 'footprint', 'private', 'working_set'])),
  cpuPercent: z.optional(bytes().check(z.maximum(100))),
  ports: z.optional(z.array(z.strictObject({ port: z.number().check(z.int(), z.minimum(1), z.maximum(65535)), inventoryEntryId: id() }))),
  level: z.enum(['proven', 'likely', 'left_behind', 'unknown']),
  evidence: z.optional(z.array(ProcessEvidenceV1Schema)),
  chain: z.optional(z.array(z.strictObject({ pid: z.number().check(z.int(), z.positive()), name: id(), exitedAtMs: z.optional(bytes()) }))),
  principalName: z.optional(z.string()),
}));
export type ProcessRowV1 = z.infer<typeof ProcessRowV1Schema>;
export const OwnerRowV1Schema = lazyZodSchema(() => z.strictObject({
  rowId: id(), owner: ProcessOwnerRefV1Schema, state: z.enum(['running', 'stopping', 'stopped']),
  canStartAgain: z.optional(z.boolean()),
  // Exact native root identity remains actionable when the owners view omits members.
  root: z.optional(z.strictObject({ ref: id(), level: z.enum(['proven', 'likely']) })),
  totals: MachineProcessesTotalsV1Schema, members: z.array(ProcessRowV1Schema),
  requester: z.optional(z.strictObject({ accountId: id(), displayName: z.string() })),
  ceiling: z.optional(z.strictObject({ limitBytes: bytes().check(z.positive()), usedBytes: z.optional(bytes()), observedAtMs: z.optional(bytes()),
    throttleCount5m: z.optional(z.number().check(z.int(), z.nonnegative())) })),
}));
export type OwnerRowV1 = z.infer<typeof OwnerRowV1Schema>;
export const LeftBehindRowV1Schema = lazyZodSchema(() => z.extend(ProcessRowV1Schema, {
  level: z.literal('left_behind'), owner: ProcessOwnerRefV1Schema, confirmedAtMs: bytes(),
}));
export type LeftBehindRowV1 = z.infer<typeof LeftBehindRowV1Schema>;
// Deliberately distinct: non-Happier rows cannot transport commands, cwd, tags,
// evidence, or a claimed Happier owner even in a detail response.
export const NotHappierRowV1Schema = lazyZodSchema(() => z.strictObject({
  name: id(), appGroup: id(), memoryBytes: z.nullable(bytes()), cpuPercent: z.optional(bytes().check(z.maximum(100))),
  pid: z.number().check(z.int(), z.positive()), ref: id(),
}));
export type NotHappierRowV1 = z.infer<typeof NotHappierRowV1Schema>;
export const AppGroupRowV1Schema = lazyZodSchema(() => z.strictObject({ appGroup: id(), members: z.array(NotHappierRowV1Schema) }));
export type AppGroupRowV1 = z.infer<typeof AppGroupRowV1Schema>;
export const MachineProcessesAnswerV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), machineId: id(), capturedAtMs: bytes(), state: z.enum(['live', 'unavailable']),
  reason: z.optional(z.enum(['helper_missing', 'read_failed', 'self_absent', 'unsupported_platform', 'all_processes_disabled', 'permission_denied'])),
  platform: z.enum(['linux', 'darwin', 'win32']), evidenceModel: z.enum(['fenced', 'tree_and_marker']),
  owners: z.array(OwnerRowV1Schema), leftBehind: z.array(LeftBehindRowV1Schema), notHappier: z.optional(z.array(AppGroupRowV1Schema)),
  otherPrincipals: z.optional(z.strictObject({ count: z.number().check(z.int(), z.nonnegative()), memoryBytes: z.nullable(bytes()), cpuPercent: z.optional(bytes().check(z.maximum(100))), names: z.array(z.string()) })),
  othersWork: z.optional(z.strictObject({ count: z.number().check(z.int(), z.nonnegative()) })),
  // Count only; unverifiable ownership never supplies a process Action target.
  unverifiableCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  totals: z.strictObject({ happier: MachineProcessesTotalsV1Schema, leftBehind: MachineProcessesTotalsV1Schema }),
  history: z.optional(z.record(id(), z.array(ProcessSampleV1Schema))),
}));
export type MachineProcessesAnswerV1 = z.infer<typeof MachineProcessesAnswerV1Schema>;
export const MachineProcessesListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), scope: z.optional(z.enum(['happier', 'all'])), view: z.optional(z.enum(['tree', 'owners'])), sessionId: z.optional(id()), query: z.optional(z.string()),
}));
export type MachineProcessesListInputV1 = z.infer<typeof MachineProcessesListInputV1Schema>;
export const MachineProcessesWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), scope: z.enum(['happier', 'all']), view: z.enum(['tree', 'owners']), since: z.optional(bytes()), detailToken: z.optional(id()),
  /** Newest history sample the client already holds: the answer's `history` then carries only newer samples per series. */
  historySince: z.optional(bytes()),
}));
export type MachineProcessesWatchInputV1 = z.infer<typeof MachineProcessesWatchInputV1Schema>;
export const MachineProcessesWatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
  z.strictObject({ changed: z.literal(false) }), z.strictObject({ changed: z.literal(true), answer: MachineProcessesAnswerV1Schema }),
]));
export type MachineProcessesWatchResultV1 = z.infer<typeof MachineProcessesWatchResultV1Schema>;
export const MachineProcessesGetInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), ref: id() }));
export type MachineProcessesGetInputV1 = z.infer<typeof MachineProcessesGetInputV1Schema>;
export const MachineProcessesGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  row: z.nullable(z.union([ProcessRowV1Schema, NotHappierRowV1Schema])), owner: z.optional(ProcessOwnerRefV1Schema), history: z.optional(z.array(ProcessSampleV1Schema)),
}));
export type MachineProcessesGetResultV1 = z.infer<typeof MachineProcessesGetResultV1Schema>;
export const MachineProcessExpectationV1Schema = lazyZodSchema(() => z.strictObject({
  level: ProcessOwnershipLevelV1Schema, owner: z.optional(ProcessOwnerRefV1Schema),
}));
export type MachineProcessExpectationV1 = z.infer<typeof MachineProcessExpectationV1Schema>;
export const MachineProcessTargetV1Schema = lazyZodSchema(() => z.strictObject({ ref: id(), expect: MachineProcessExpectationV1Schema }));
export type MachineProcessTargetV1 = z.infer<typeof MachineProcessTargetV1Schema>;
const uniqueRefs = (refs: readonly string[]) => new Set(refs).size === refs.length;
const refs = () => z.array(id()).check(z.minLength(1), z.refine(uniqueRefs, 'Process refs must be distinct'));
const targets = () => z.array(MachineProcessTargetV1Schema).check(z.minLength(1), z.refine(items => uniqueRefs(items.map(item => item.ref)), 'Process refs must be distinct'));
export const MachineProcessesCheckInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), refs: refs() }));
export type MachineProcessesCheckInputV1 = z.infer<typeof MachineProcessesCheckInputV1Schema>;
export const MachineProcessesCheckResultV1Schema = lazyZodSchema(() => z.strictObject({ checks: z.array(z.strictObject({
  ref: id(), present: z.boolean(), identityEqual: z.boolean(), level: z.optional(ProcessOwnershipLevelV1Schema), owner: z.optional(z.nullable(ProcessOwnerRefV1Schema)), memoryBytes: z.optional(z.nullable(bytes())),
})) }));
export type MachineProcessesCheckResultV1 = z.infer<typeof MachineProcessesCheckResultV1Schema>;
export const MachineProcessesStopInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), targets: targets() }));
export type MachineProcessesStopInputV1 = z.infer<typeof MachineProcessesStopInputV1Schema>;
export const MachineProcessesKillInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), targets: targets(), tree: z.boolean() }));
export type MachineProcessesKillInputV1 = z.infer<typeof MachineProcessesKillInputV1Schema>;
export const MachineProcessesActionResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ended', 'partial', 'refused', 'failed']), outcomes: z.array(z.strictObject({
    ref: id(), outcome: z.enum(['ended', 'survived', 'gone_before', 'refused']), reasonCode: z.optional(id()), freedBytes: z.optional(bytes()),
  })),
}));
export type MachineProcessesActionResultV1 = z.infer<typeof MachineProcessesActionResultV1Schema>;
export const MachineProcessesCleanUpInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), refs: refs() }));
export type MachineProcessesCleanUpInputV1 = z.infer<typeof MachineProcessesCleanUpInputV1Schema>;
export const MachineProcessesCleanUpResultV1Schema = lazyZodSchema(() => z.strictObject({
  ended: z.array(z.strictObject({ ref: id(), freedBytes: bytes() })), skipped: z.array(z.strictObject({ ref: id(), reason: id() })),
}));
export type MachineProcessesCleanUpResultV1 = z.infer<typeof MachineProcessesCleanUpResultV1Schema>;
export const MachineProcessesStartAgainInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), ref: id() }));
export type MachineProcessesStartAgainInputV1 = z.infer<typeof MachineProcessesStartAgainInputV1Schema>;
export const MachineProcessesStartAgainResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['started', 'already_wakes_on_next_message', 'refused', 'failed']), reasonCode: z.optional(id()),
  // Carry the original launcher's declaration review into its existing review flow.
  // The canonical launcher schemas retain authority over requests and effect payloads.
  serviceStart: z.optional(z.strictObject({
    request: DaemonLocalServiceLauncherStartRequestV1Schema,
    response: DaemonLocalServiceLauncherStartResponseV1Schema,
  }).check(z.superRefine(({ request, response }, ctx) => {
    if (request.machineId !== response.machineId) ctx.addIssue({ code: "custom", path: ['response', 'machineId'], message: 'Launcher response must match the original request Machine.' });
    if (request.targetId !== response.targetId) ctx.addIssue({ code: "custom", path: ['response', 'targetId'], message: 'Launcher response must match the original request target.' });
  }))),
}));
export type MachineProcessesStartAgainResultV1 = z.infer<typeof MachineProcessesStartAgainResultV1Schema>;
