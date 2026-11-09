import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { createManagedMachineV1Schema } from './managedMachineV1.js';
import { ManagedAcquireInputV1Schema, ManagedAdmissionInputV1Schema, ManagedCancelInputV1Schema,
  ManagedControllerCurrentnessV1Schema, ManagedControllerContextInputV1Schema, ManagedEnrollmentCorrelationV1Schema,
  ManagedControllerReportV1Schema, ManagedControllerSubmitInputV1Schema, ManagedControllerUpdateInputV1Schema } from './actionsV1.js';
import { ManagedPolicyAdmissionInputV1Schema } from './managedPolicyV1.js';
import { ManagedWakeTargetV1Schema } from './managedIntentV1.js';
import { ManagedInstallationPurposeV1Schema } from './managedInstallationV1.js';
import { ManagedResourceV1Schema } from './providerFactsV1.js';
import { isManagedDevcontainerChildProjectionCurrentV1 } from './devcontainerV1.js';

describe('managed resource persistence and input contracts', () => {
  const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' } as const;
  const schema = createManagedMachineV1Schema(
    z.strictObject({ image: z.string() }),
    z.strictObject({ instance: z.string(), store: z.string() }),
  );
  const row = {
    id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'guest', choices: { image: 'linux' } },
    controller: { machineId: 'controller', installationId: 'install' },
    allocation: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'guest', store: '/lima' } },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  };
  it('retains Account cloud resources and admitted follow-ups without a controller while rejecting partial pairs', () => {
    const { controller, ...portable } = row;
    expect(schema.parse(portable)).toEqual(portable);
    expect(createStoredReadSchema(schema).parse(portable)).toEqual(portable);
    const current = { homeId: row.homeId, managedId: row.id, expectedIntentRevision: 0, requestId: 'request' };
    const carriers = [
      [ManagedControllerCurrentnessV1Schema, current],
      [ManagedControllerSubmitInputV1Schema, current],
      [ManagedControllerContextInputV1Schema, current],
      [ManagedEnrollmentCorrelationV1Schema, { ...current, resource: row.resource }],
      [ManagedControllerReportV1Schema, { ...current, result: { kind: 'bound', resource: row.resource } }],
      [ManagedInstallationPurposeV1Schema, { ...current, resource: row.resource,
        operationId: 'operation', taskId: 'task', expectedPromptKind: 'ssh.trustHost', phase: 'answer' }],
    ] as const;
    for (const [carrier, value] of carriers) {
      expect(carrier.safeParse(value).success).toBe(true);
      expect(carrier.safeParse({ ...value, controller }).success).toBe(true);
      expect(carrier.safeParse({ ...value, controller: { machineId: controller.machineId } }).success).toBe(false);
      expect(carrier.safeParse({ ...value, controller: { installationId: controller.installationId } }).success).toBe(false);
    }
    expect(schema.safeParse({ ...portable, controller: { machineId: controller.machineId } }).success).toBe(false);
    expect(schema.parse({ ...portable, submittedNativeEffect: { intentRevision: 0, requestId: 'request', intent: 'start' } }))
      .toMatchObject({ submittedNativeEffect: { intentRevision: 0, requestId: 'request', intent: 'start' } });
    expect(ManagedControllerUpdateInputV1Schema.parse({ homeId: row.homeId, managedId: row.id,
      expectedIntentRevision: 0, controller: null, reviewedPendingEffects: true }).controller).toBeNull();
    expect(ManagedPolicyAdmissionInputV1Schema.safeParse({ ...current, purpose: { kind: 'retention' } }).success).toBe(false);
    expect(ManagedPolicyAdmissionInputV1Schema.safeParse({ ...current, controller, purpose: { kind: 'retention' } }).success).toBe(true);
    expect(ManagedWakeTargetV1Schema.parse({ homeId: row.homeId, managedId: row.id, enrolledMachineId: 'guest',
      expectedIntentRevision: 0, origin: { kind: 'finite-command', actionRequestId: 'request' }, reason: 'admitted-work' }))
      .not.toHaveProperty('controller');
  });
  it('retains installation completion on a bound resource without inventing enrollment or an operation', () => {
    const installed = { ...row, bootstrapInstalled: true };
    expect(schema.parse(installed)).toEqual(installed);
    expect(createStoredReadSchema(schema).parse(installed)).toEqual(installed);
    expect(schema.parse(row)).not.toHaveProperty('bootstrapInstalled');
    const report = { homeId: row.homeId, managedId: row.id, expectedIntentRevision: 0, requestId: 'request',
      result: { kind: 'bound', resource: row.resource }, bootstrapInstalled: true };
    expect(ManagedControllerReportV1Schema.parse(report)).toEqual(report);
    expect(ManagedControllerReportV1Schema.safeParse({ ...report, bootstrapInstalled: false }).success).toBe(false);
    expect(ManagedControllerReportV1Schema.safeParse({ ...report, result: { kind: 'unknown', recovery: {
      reference: row.id, reason: 'native_acquisition_unconfirmed' } } }).success).toBe(false);
  });
  it('rejects the unwritten retired creation state while preserving canceled resource history', () => {
    expect(schema.safeParse({ ...row, creationState: 'retired' }).success).toBe(false);
    expect(schema.parse({ ...row, creationState: 'canceled' }).creationState).toBe('canceled');
  });
  it('admits an absolute retention deadline without a redundant interrupt marker', () => {
    const retention = { kind: 'deadline', at: 4_000, effect: 'delete' };
    expect(schema.parse({ ...row, retention }).retention).toEqual(retention);
    expect(schema.safeParse({ ...row, retention: { ...retention, interrupts: true } }).success).toBe(false);
  });
  it('carries the server enrollment Account while accepting historical projections without it', () => {
    const admitted = { ...row, enrollmentAccountId: 'requester' };
    expect(schema.parse(admitted)).toEqual(admitted);
    expect(schema.parse(row)).toEqual(row);
    expect(schema.safeParse({ ...row, enrollmentAccountId: '' }).success).toBe(false);
    expect(ManagedAdmissionInputV1Schema.safeParse({ input: {
      selection: { kind: 'one-off', homeId: row.homeId, launch: row.launch, controller: row.controller,
        retention: row.retention, wakeOnAcceptedMessage: false }, enrollmentIdentity, enrollmentAccountId: 'selected-by-caller',
    }, requestId: 'request', continuationPresent: false }).success).toBe(false);
  });
  it('requires reviewed identity on both acquire arms and keeps its public projection strict and secret-free', () => {
    const requests = [
      { selection: { kind: 'one-off', homeId: row.homeId, launch: row.launch, controller: row.controller, retention: row.retention, wakeOnAcceptedMessage: false } },
      { selection: { kind: 'preset', homeId: row.homeId, id: 'preset', revision: 1 }, controller: row.controller, retention: row.retention, wakeOnAcceptedMessage: false },
    ];
    for (const input of requests) {
      expect(ManagedAcquireInputV1Schema.safeParse(input).success).toBe(false);
      expect(ManagedAcquireInputV1Schema.parse({ ...input, enrollmentIdentity }).enrollmentIdentity).toEqual(enrollmentIdentity);
      expect(ManagedAcquireInputV1Schema.safeParse({ ...input, enrollmentIdentity: { ...enrollmentIdentity, password: 'not-retained' } }).success).toBe(false);
    }
    expect(schema.parse({ ...row, enrollmentIdentity }).enrollmentIdentity).toEqual(enrollmentIdentity);
    expect(schema.parse(row)).toEqual(row);
  });
  it('normalizes a retained creation snapshot before retry without changing its lifecycle facts', () => {
    const body = 'echo retained\r\n';
    const stored = { ...row, preset: { id: 'preset', revision: 4 }, enrolledMachineId: 'guest',
      machineSetup: { setup: { setupScript: body, setupScriptAffects: 'none' }, state: 'failed',
        errorCode: 'setup_failed', operation: { operationId: 'retained-setup' } } };
    const canonical = { ...stored, machineSetup: { ...stored.machineSetup,
      setup: { scripts: [{ body, affects: 'none' }] } } };
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(canonical);
    expect(schema.parse(canonical)).toEqual(canonical);
    expect(schema.safeParse(stored).success).toBe(false);
  });
  it('retains the exact preset environment and independent setup outcome on the creation row', () => {
    const setup = { ...row, preset: { id: 'preset', revision: 4 }, enrolledMachineId: 'guest',
      machineSetup: { setup: { scripts: [{ body: 'echo prepared' }] }, state: 'failed', errorCode: 'setup_failed' } };
    expect(schema.parse(setup)).toEqual(setup);
    expect(createStoredReadSchema(schema).parse({ ...setup, machineSetup: { ...setup.machineSetup, future: true } })).toEqual(setup);
    expect(schema.safeParse({ ...setup, preset: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...setup, machineSetup: { ...setup.machineSetup, state: 'succeeded', errorCode: 'setup_failed' } }).success).toBe(false);
  });
  it.each(['succeeded', 'failed', 'skipped'] as const)('retains historical %s setup when lifecycle retires the current enrollment', state => {
    const retired = { ...row, creationState: 'canceled', allocation: 'confirmed-absent', desired: 'delete',
      preset: { id: 'preset', revision: 4 }, machineSetup: { setup: { scripts: [{ body: 'echo admitted' }] }, state,
        operation: { operationId: 'finished-setup' }, ...(state === 'failed' ? { errorCode: 'setup_failed' } : {}) } };
    expect(schema.parse(retired)).toEqual(retired);
    expect(createStoredReadSchema(schema).parse({ ...retired, machineSetup: { ...retired.machineSetup, future: true } })).toEqual(retired);
    expect(schema.safeParse({ ...retired, preset: undefined }).success).toBe(false);
  });
  it('captures each distinct purpose and its connection basis without admitting that basis as a selection', () => {
    const credentials = ['cloud', 'cua'].map(purpose => ({
      purpose: { consumer: row.launch.provider, purpose },
      account: { service: { pluginId: 'acme.accounts', localId: purpose }, accountId: `selected-${purpose}` },
    }));
    const selection = { kind: 'one-off', homeId: row.homeId, controller: row.controller,
      launch: { ...row.launch, credentials }, retention: row.retention, wakeOnAcceptedMessage: false };
    expect(ManagedAdmissionInputV1Schema.safeParse({ input: { selection, enrollmentIdentity }, requestId: 'request', continuationPresent: false }).success).toBe(true);
    const retained = { ...row, launch: { ...row.launch, credentials: credentials.map((credential, index) => ({
      ...credential, configurationRevision: index === 0 ? 'cloud-configuration' : null,
    })) } };
    expect(schema.parse(retained)).toEqual(retained);
    expect(createStoredReadSchema(schema).parse(retained)).toEqual(retained);
    expect(schema.safeParse({ ...row, launch: { ...row.launch, credentials: [credentials[0], credentials[0]] } }).success).toBe(false);
    expect(ManagedAdmissionInputV1Schema.safeParse({ input: { enrollmentIdentity, selection: { ...selection, launch: retained.launch } }, requestId: 'request', continuationPresent: false }).success).toBe(false);
  });
  it('retains the configuration revision separately from public launch selection and native identity', () => {
    const credential = { purpose: { consumer: row.launch.provider, purpose: 'upstream' },
      account: { service: { pluginId: 'acme.accounts', localId: 'coordinator' }, accountId: 'selected' } };
    const retained = { ...row, launch: { ...row.launch, credentials: [{ ...credential, configurationRevision: 'configuration-1' }] } };
    expect(schema.safeParse(retained)).toMatchObject({ success: true, data: retained });
    expect(createStoredReadSchema(schema).parse(retained)).toEqual(retained);
    expect(ManagedAdmissionInputV1Schema.safeParse({ input: { enrollmentIdentity, selection: { kind: 'one-off', homeId: row.homeId,
      controller: row.controller, launch: retained.launch, retention: row.retention, wakeOnAcceptedMessage: false } },
      requestId: 'request', continuationPresent: false }).success).toBe(false);
  });
  it('retains a closed observed child namespace on the same admitted native resource', () => {
    const devcontainerObservation = { nativeResourceId: 'native-child', user: 'custom-user', workspaceFolder: '/work/custom',
      storage: { kind: 'bind', hostPath: '/host/project', childPath: '/work/custom' } };
    const resource = { ...row.resource, devcontainerObservation };
    expect(ManagedResourceV1Schema.safeParse(resource)).toMatchObject({ success: true, data: resource });
    const childRow = { ...row, resource, enrolledMachineId: 'child-machine', devcontainerChild: {
      relation: { managedMachineId: row.id, managedMachineKind: 'devcontainer', parentMachineId: row.controller.machineId },
      observation: devcontainerObservation,
    } };
    expect(schema.safeParse(childRow)).toMatchObject({ success: true, data: childRow });
    expect(schema.safeParse({ ...childRow, controller: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...childRow, devcontainerChild: { ...childRow.devcontainerChild,
      relation: { ...childRow.devcontainerChild.relation, parentMachineId: 'another-controller' } } }).success).toBe(false);
    expect(schema.safeParse({ ...childRow, enrolledMachineId: undefined }).success).toBe(false);
    const stored = { ...childRow, devcontainerChild: { ...childRow.devcontainerChild, futureProjection: true,
      observation: { ...devcontainerObservation, storage: { ...devcontainerObservation.storage, futureStorage: true } } } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(childRow);
    expect(ManagedResourceV1Schema.safeParse({ ...resource, devcontainerObservation: { ...devcontainerObservation,
      workspaceFolder: '/work/elsewhere' } }).success).toBe(false);
  });
  it('reads nested stored extras while refusing them at write admission', () => {
    const stored = { ...row, launch: { ...row.launch, futureEnvelope: true, choices: { ...row.launch.choices, future: true } }, resource: { ...row.resource, value: { ...row.resource.value, future: true } } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(row);
  });
  it('recognizes an enrolled child only in its active bound Home and native namespace', () => {
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: '/work/child',
      storage: { kind: 'child' as const, childPath: '/work/child' } };
    const managedMachine = { ...row, enrolledMachineId: 'child', resource: { ...row.resource, devcontainerObservation: observation } };
    const projection = { relation: { managedMachineId: row.id, managedMachineKind: 'devcontainer' as const,
      parentMachineId: row.controller.machineId }, observation };
    const input = { homeId: row.homeId, machineId: 'child', projection, managedMachine };
    expect(isManagedDevcontainerChildProjectionCurrentV1(input)).toBe(true);
    expect(isManagedDevcontainerChildProjectionCurrentV1({ ...input, homeId: 'another-Home' })).toBe(false);
    expect(isManagedDevcontainerChildProjectionCurrentV1({ ...input, managedMachine: { ...managedMachine, enrolledMachineId: 'replacement' } })).toBe(false);
    expect(isManagedDevcontainerChildProjectionCurrentV1({ ...input, managedMachine: { ...managedMachine, creationState: 'canceled' } })).toBe(false);
    expect(isManagedDevcontainerChildProjectionCurrentV1({ ...input, managedMachine: { ...managedMachine, allocation: 'may-exist' } })).toBe(false);
    expect(isManagedDevcontainerChildProjectionCurrentV1({ ...input, managedMachine: { ...managedMachine, resource: { ...managedMachine.resource,
      devcontainerObservation: { ...observation, nativeResourceId: 'replacement-native' } } } })).toBe(false);
  });
  it('rejects bound resources without identity and canceled enrollment', () => {
    expect(schema.safeParse({ ...row, resource: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...row, creationState: 'canceled', enrolledMachineId: 'late' }).success).toBe(false);
    expect(schema.safeParse({ ...row, resource: { ...row.resource, contributionRef: { pluginId: 'happier.machine.other', localId: 'other' } } }).success).toBe(false);
  });
  it('validates declared pending handles strictly and tolerates stored extras without losing recovery identity', () => {
    const pendingSchema = createManagedMachineV1Schema(
      z.strictObject({ image: z.string() }),
      z.strictObject({ instance: z.string(), store: z.string() }),
      z.strictObject({ request: z.string(), region: z.string() }),
    );
    const nativeOperationRef = { contributionRef: row.launch.provider, schemaVersion: row.launch.schemaVersion,
      value: { request: 'submitted-native-request', region: 'reviewed-region' } };
    const pending = { ...row, allocation: 'may-exist', resource: undefined, nativeOperationRef };
    expect(pendingSchema.parse(pending).nativeOperationRef).toEqual(nativeOperationRef);
    const stored = { ...pending, nativeOperationRef: { ...nativeOperationRef, futureEnvelope: true,
      value: { ...nativeOperationRef.value, futureNative: true } } };
    expect(pendingSchema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(pendingSchema).parse(stored).nativeOperationRef).toEqual(nativeOperationRef);
    expect(pendingSchema.safeParse({ ...pending, nativeOperationRef: { ...nativeOperationRef, value: { request: 17, region: 'reviewed-region' } } }).success).toBe(false);
    expect(pendingSchema.safeParse({ ...pending, nativeOperationRef: { ...nativeOperationRef, schemaVersion: 2 } }).success).toBe(false);
    expect(pendingSchema.safeParse({ ...pending, nativeOperationRef: { ...nativeOperationRef, contributionRef: { pluginId: 'happier.machine.other', localId: 'other' } } }).success).toBe(false);
    // Missing reconciliation support does not erase retained recovery data.
    expect(createStoredReadSchema(schema).parse(pending).nativeOperationRef).toEqual(nativeOperationRef);
  });
  it('retains category-default idle intent without requiring an explicit duration', () => {
    const deferred = { ...row, desired: 'stop', desiredWhen: 'after-idle' };
    expect(schema.parse(deferred)).toEqual(deferred);
    expect(schema.parse({ ...deferred, desiredAfterMs: 3_600_000 }).desiredAfterMs).toBe(3_600_000);
    expect(schema.safeParse({ ...row, desiredAfterMs: 3_600_000 }).success).toBe(false);
  });
  it('admits compute and a continuation marker without accepting private Agent authoring', () => {
    const input = { enrollmentIdentity, selection: { kind: 'one-off', homeId: row.homeId, launch: row.launch, controller: row.controller, retention: row.retention, wakeOnAcceptedMessage: row.wakeOnAcceptedMessage } };
    expect(ManagedAdmissionInputV1Schema.safeParse({ input, requestId: 'request', continuationPresent: true }).success).toBe(true);
    expect(ManagedAdmissionInputV1Schema.safeParse({ input: { ...input, agentStart: { initialInput: { text: 'private-message' } } }, requestId: 'request', continuationPresent: true }).success).toBe(false);
    expect(ManagedAdmissionInputV1Schema.safeParse({ input, requestId: 'request' }).success).toBe(false);
  });
  it('cancels the authorized current creation without exposing its private Action request', () => {
    const input = { homeId: row.homeId, managedId: row.id, expectedIntentRevision: row.intentRevision };
    expect(ManagedCancelInputV1Schema.parse(input)).toEqual(input);
    expect(ManagedCancelInputV1Schema.safeParse({ ...input, creationRequestId: 'private-request' }).success).toBe(false);
  });
});
