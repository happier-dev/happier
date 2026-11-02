import type { MachinePresetActionIdV1 } from '../../machines/managed/machinePresetActionIdsV1.js';
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

export const MACHINE_PRESET_INPUT_FIELDS = {
  'machines.presets.list': [home, owner,
    { path: 'search', title: 'Search', widget: 'text' },
    { path: 'includeArchived', title: 'Include archived presets', widget: 'boolean' },
    { path: 'cursor', title: 'Page cursor', widget: 'text' }],
  'machines.presets.get': [home, preset],
  'machines.presets.create': [home, preset, name, { ...owner, required: true },
    { path: 'launch', title: 'Provisioning launch', widget: 'json', required: true }, controller,
    { path: 'setup', title: 'Machine setup', widget: 'json' },
    { ...retention, required: false }, { ...wake, required: false },
    { path: 'simultaneousLimit', title: 'Simultaneous machine limit', widget: 'json' }],
  'machines.presets.update': [home, preset, revision,
    { path: 'patch', title: 'Preset changes', widget: 'json', required: true }],
  'machines.presets.archive': [home, preset, revision],
  'machines.presets.restore': [home, preset, revision],
} satisfies Record<MachinePresetActionIdV1, ActionInputFieldHint[]>;

export const MACHINE_POOL_INPUT_FIELDS = {
  'machines.pools.list': [],
  'machines.pools.get': [pool],
  'machines.pools.create': [pool, name, description, members],
  'machines.pools.update': [pool, revision, name, description, members],
  'machines.pools.delete': [pool, revision],
  'machines.pools.resolve': [pool,
    { path: 'requestKey', title: 'Selection request key', widget: 'text', required: true },
    { path: 'purpose', title: 'Execution purpose', widget: 'text' },
    { path: 'workspace', title: 'Workspace', widget: 'json' },
    { path: 'memoryDemand', title: 'Memory demand', widget: 'json' }],
} satisfies Record<MachinePoolActionIdV1, ActionInputFieldHint[]>;

export const MANAGED_MACHINE_INPUT_FIELDS = {
  'machines.environment.apply': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'presetId', title: 'Preset id', widget: 'text', required: true },
    { path: 'presetRevision', title: 'Preset revision', widget: 'integer', required: true }],
'machines.setup.remove': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true }],
'machines.managed.credentials.install': [home, managed,
    { path: 'operation', title: 'Binding operation', widget: 'select', options: [{ value: 'install', label: 'Install' }, { value: 'release', label: 'Release' }] },
    { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
    { path: 'executionRunId', title: 'Attached Run id', widget: 'text' },
    { path: 'bindingKey', title: 'Accepted binding', widget: 'text', required: true },
    { path: 'expectedResourceRevision', title: 'Credential revision', widget: 'number', required: true },
    { path: 'expectedSourceRevision', title: 'Source revision', widget: 'text', required: true },
    { path: 'expectedProviderTicket', title: 'Accepted source reference', widget: 'text', required: true }],
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
  'machines.managed.references.get': [home, managed],
  'machines.managed.inspect': [home, managed],
  'machines.managed.bootstrap.retry': [home, managed, intentRevision],
  'machines.managed.setup.skip': [home, managed, intentRevision],
  'machines.setup.plan': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'sources.[].setup.items.[].selection.ref', title: 'Software', widget: 'select',
      optionsSourceId: 'machines.setup.software.available' }],
  'machines.setup.apply': [home,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'targets.[].sources.[].setup.items.[].selection.ref', title: 'Software', widget: 'select',
      optionsSourceId: 'machines.setup.software.available' }],
  'machines.managed.cancel': [home, managed, intentRevision],
  'machines.managed.power.set': effectFields(nativeEffectOptions.filter(option => option.value !== 'delete')),
  'machines.managed.delete': [...effectFields(nativeEffectOptions.filter(option => option.value === 'delete')),
    { path: 'reviewedDependencies', title: 'Dependencies reviewed', widget: 'boolean', required: true }],
  'machines.managed.rebuild': [home,
    { path: 'managedMachineId', title: 'Managed machine id', widget: 'text', required: true }, revision,
    { path: 'kind', title: 'Requested effect', widget: 'text', required: true },
    { path: 'reviewedEffectDigest', title: 'Reviewed effect digest', widget: 'text', required: true }],
  'machines.managed.retention.update': [home, managed, intentRevision, retention, wake],
  'machines.managed.controller.update': [home, managed, intentRevision, controller,
    { path: 'reviewedPendingEffects', title: 'Pending effects reviewed', widget: 'boolean', required: true }],
  'machines.managed.retire': [home, managed, intentRevision,
    { path: 'manualResponsibility', title: 'Manual responsibility accepted', widget: 'boolean', required: true }],
} satisfies Record<ManagedMachineActionIdV1, ActionInputFieldHint[]>;
