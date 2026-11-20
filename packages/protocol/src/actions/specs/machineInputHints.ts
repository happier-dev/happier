import { MACHINE_PRESET_PREPARE_ACTION_ID_V1, type MachinePresetActionIdV1 } from '../../machines/managed/machinePresetActionIdsV1.js';
import type { ManagedMachineActionIdV1 } from '../../machines/managed/actionIdsV1.js';
import type { MachinePoolActionIdV1 } from '../../machines/pools/actionsV1.js';
import type { ActionInputFieldHint, ActionInputOption } from '../actionInputHintsRuntime.js';

// Explicit producer metadata keeps review operands visible without inspecting
// lazy schemas at catalog startup or guessing fields from arbitrary input.
const home = { path: 'homeId', title: 'Home', widget: 'text', required: true } as const;
const preset = { path: 'id', title: 'Preset id', widget: 'text', required: true } as const;
const managed = { path: 'managedId', title: 'Managed machine id', widget: 'text', required: true } as const;
const pool = { path: 'poolId', title: 'Pool id', widget: 'text', required: true } as const;
const revision = { path: 'expectedRevision', title: 'Expected revision', widget: 'integer', required: true } as const;
const intentRevision = { path: 'expectedIntentRevision', title: 'Expected intent revision', widget: 'integer', required: true } as const;
const name = { path: 'name', title: 'Name', widget: 'text', required: true } as const;
const controller = { path: 'controller', title: 'Controller', widget: 'json', required: true } as const;
const retention = { path: 'retention', title: 'Retention policy', widget: 'json', required: true } as const;
const wake = { path: 'wakeOnAcceptedMessage', title: 'Wake on accepted message', widget: 'boolean', required: true } as const;
const owner = { path: 'owner', title: 'Owner', widget: 'json' } as const;
const contribution = { path: 'contribution', title: 'Provisioner', widget: 'json', required: true } as const;
const credentials = { path: 'credentials', title: 'Credential selections', widget: 'json' } as const;
const members = { path: 'members', title: 'Machine members and priority tiers', widget: 'json', required: true } as const;
const description = { path: 'description', title: 'Description', widget: 'textarea' } as const;
const poolAudience = { path: 'audience', title: 'Pool audience', widget: 'json' } as const;
// Revision is required only for immediate effects; the strict domain union
// validates deferred effects without making the absent arm unreviewable.
const nativeEffectOptions = [
  { value: 'start', label: 'Start', labelKey: 'actionPresentation.options.start' },
  { value: 'stop', label: 'Stop', labelKey: 'actionPresentation.options.stop' },
  { value: 'suspend', label: 'Suspend', labelKey: 'actionPresentation.options.suspend' },
  { value: 'resume', label: 'Resume', labelKey: 'actionPresentation.options.resume' },
  { value: 'delete', label: 'Delete', labelKey: 'actionPresentation.options.delete' },
] satisfies ActionInputOption[];
const effectFields = (options: readonly ActionInputOption[]): ActionInputFieldHint[] => [home, managed,
  { path: 'when', title: 'When', widget: 'select', required: true, options: [
    { value: 'now', label: 'Now', labelKey: 'actionPresentation.options.now' },
    { value: 'after-idle', label: 'After idle', labelKey: 'actionPresentation.options.afterIdle' },
  ] },
  { path: 'intent', title: 'Requested effect', widget: 'select', required: true, options },
  { ...revision, required: false },
  { path: 'afterMs', title: 'Idle delay (milliseconds)', widget: 'number' },
];

// Review the carrier's public tag and opened plain content. Ciphertext and
// wrapped recipient keys remain in replay custody, never in review rows.
const presetContentFields = (prefix: string): ActionInputFieldHint[] => [
  { path: `${prefix}contentEncryptionMode`, title: 'Content encryption mode', widget: 'text' },
  { path: `${prefix}content.t`, title: 'Content', widget: 'text' },
  { path: `${prefix}content.v`, title: 'Preset configuration', widget: 'json', required: true,
    visibleWhen: { op: 'eq', path: `${prefix}content.t`, value: 'plain' } },
  { path: `${prefix}recipients.[].accountId`, title: 'Recipients', widget: 'text' },
];
const presetControlFields: ActionInputFieldHint[] = [
  { ...controller, required: false },
  { path: 'controllerPoolId', title: 'Controller pool id', widget: 'text' },
  { ...retention, required: false }, { ...wake, required: false },
  { path: 'teamAcquireDelegated', title: 'Team acquisition delegated', widget: 'boolean' },
  { path: 'simultaneousLimit', title: 'Simultaneous machine limit', widget: 'json' },
];

export const MACHINE_PRESET_INPUT_FIELDS = {
  'machines.presets.list': [home, owner,
    { path: 'includeArchived', title: 'Include archived presets', widget: 'boolean' },
    { path: 'cursor', title: 'Page cursor', widget: 'text' }],
  'machines.presets.get': [home, preset],
  'machines.presets.create': [home, preset, { ...owner, required: true },
    ...presetContentFields(''), ...presetControlFields],
  'machines.presets.update': [home, preset, revision,
    ...presetContentFields('patch.'),
    ...presetControlFields.map(field => ({ ...field, path: `patch.${field.path}` }))],
  'machines.presets.archive': [home, preset, revision],
  'machines.presets.restore': [home, preset, revision],
  [MACHINE_PRESET_PREPARE_ACTION_ID_V1]: [home, preset, revision,
    { path: 'machineId', title: 'Build machine', widget: 'text', required: true }],
} satisfies Record<MachinePresetActionIdV1, ActionInputFieldHint[]>;

export const MACHINE_POOL_INPUT_FIELDS = {
  'machines.pools.list': [{ path: 'memberMachineIds', title: 'Machines to check for pool membership', widget: 'json' }],
  'machines.pools.get': [pool],
  'machines.pools.create': [pool, name, description, poolAudience, members],
  'machines.pools.update': [pool, revision, name, description, poolAudience, members],
  'machines.pools.delete': [pool, revision],
  'machines.pools.resolve': [pool,
    { path: 'requestKey', title: 'Selection request key', widget: 'text', required: true },
    { path: 'purpose', title: 'Execution purpose', widget: 'text' },
    { path: 'preset', title: 'Managed preset identity and revision', widget: 'json' },
    { path: 'workspace', title: 'Workspace', widget: 'json' },
    { path: 'memoryDemand', title: 'Memory demand', widget: 'json' }],
} satisfies Record<MachinePoolActionIdV1, ActionInputFieldHint[]>;

export const MANAGED_MACHINE_INPUT_FIELDS = {
  'machines.provisioners.list': [home, { ...controller, required: false }, { ...contribution, required: false }],
  'machines.provisioners.check': [home, controller, contribution, credentials],
  'machines.provisioners.options': [home, controller, contribution, credentials,
    { path: 'selectors', title: 'Provisioning choices', widget: 'json', required: true }],
  'machines.managed.acquire': [
    { path: 'selection', title: 'Reviewed machine selection', widget: 'json', required: true },
    { path: 'enrollmentIdentity', title: 'Reviewed enrollment identity', widget: 'json', required: true },
    { ...controller, required: false }, { ...retention, required: false }, { ...wake, required: false },
    { path: 'agentStart', title: 'Agent startup', widget: 'json' },
    { path: 'reviewedFacts', title: 'Reviewed configuration facts', widget: 'json' }],
  'machines.managed.list': [home, { path: 'archived', title: 'Archived machines', widget: 'boolean' },
    { path: 'presetId', title: 'Preset id', widget: 'text' },
    { path: 'enrolledMachineId', title: 'Enrolled machine id', widget: 'text' }],
  'machines.managed.get': [home, managed],
  'machines.managed.birth.get': [home, managed],
  'machines.managed.references.get': [home, managed],
  'machines.managed.inspect': [home, managed,
    { path: 'includeGuestDiagnostics', title: 'Read redacted guest daemon logs', widget: 'boolean' }],
  'machines.managed.credentials.install': [home, managed,
    { path: 'operation', title: 'Binding operation', widget: 'select', options: [{ value: 'install', label: 'Install' }, { value: 'release', label: 'Release' }] },
    { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
    { path: 'executionRunId', title: 'Attached Run id', widget: 'text' },
    { path: 'bindingKey', title: 'Accepted binding', widget: 'text', required: true },
    { path: 'expectedResourceRevision', title: 'Credential revision', widget: 'number', required: true },
    { path: 'expectedSourceRevision', title: 'Source revision', widget: 'text', required: true },
    { path: 'expectedProviderTicket', title: 'Accepted source reference', widget: 'text', required: true }],
  'machines.managed.bootstrap.retry': [home, managed, intentRevision],
  'machines.managed.setup.skip': [home, managed, intentRevision],
  'machines.setup.plan': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'sources.0.setup.items.0.selection.ref', title: 'Software', widget: 'select',
      visibleWhen: { op: 'eq', path: 'sources.0.setup.items.0.kind', value: 'softwareRecipe' },
      optionsSourceId: 'machines.setup.software.available' }],
  'machines.setup.apply': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'targets.0.sources.0.setup.items.0.selection.ref', title: 'Software', widget: 'select',
      visibleWhen: { op: 'eq', path: 'targets.0.sources.0.setup.items.0.kind', value: 'softwareRecipe' },
      optionsSourceId: 'machines.setup.software.available' }],
  'machines.setup.remove': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true }],
  'machines.setup.updates.apply': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'scope', title: 'Updates', widget: 'select', required: true,
      options: [{ value: 'security', label: 'Security updates' }, { value: 'all', label: 'All updates' }] },
    { path: 'plan', title: 'Reviewed updates plan', widget: 'json', required: true }],
  'machines.setup.updates.rollout': [home,
    { path: 'machineId', title: 'Workflow host Machine', widget: 'text', required: true },
    { path: 'batches', title: 'Reviewed update batches', widget: 'json', required: true },
    { path: 'failurePolicy', title: 'Workflow failure policy', widget: 'text', required: true }],
  'machines.managed.cancel': [home, managed, intentRevision],
  'machines.managed.power.set': effectFields(nativeEffectOptions.filter(option => option.value !== 'delete')),
  'machines.managed.delete': [...effectFields(nativeEffectOptions.filter(option => option.value === 'delete')),
    { path: 'reviewedDependencies', title: 'Dependencies reviewed', widget: 'boolean', required: true }],
  'machines.managed.rebuild': [home,
    { path: 'managedMachineId', title: 'Managed machine id', widget: 'text', required: true }, revision,
    { path: 'kind', title: 'Requested effect', widget: 'text', required: true },
    { path: 'reviewedEffectDigest', title: 'Reviewed effect digest', widget: 'text', required: true }],
  'machines.managed.retention.update': [home, managed, intentRevision, retention, wake],
  'machines.managed.resize': [home, managed,
    { path: 'size.cpuCores', title: 'CPU cores', widget: 'number' },
    { path: 'size.memoryBytes', title: 'Memory (bytes)', widget: 'integer' },
    { path: 'size.diskBytes', title: 'Disk (bytes)', widget: 'integer' }],
  'machines.managed.controller.update': [home, managed, intentRevision, controller,
    { path: 'reviewedPendingEffects', title: 'Pending effects reviewed', widget: 'boolean', required: true }],
  'machines.managed.retire': [home, managed, intentRevision,
    { path: 'manualResponsibility', title: 'Manual responsibility accepted', widget: 'boolean', required: true }],
} satisfies Record<ManagedMachineActionIdV1, ActionInputFieldHint[]>;
