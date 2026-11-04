import { describe, expect, it } from 'vitest';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import {
  canRetryManagedInstallation,
  currentManagedCreationOperation,
  describeManagedCreation,
  describeManagedInstallationFailure,
  managedCreationState,
  managedMachineDestination,
  managedCreationSetup,
  managedPowerExplainsOffline,
  managedReceiptPowerIntents,
} from './managedCreationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { ProviderObservationV1Schema, type RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

const machine = {
  id: 'managed',
  homeId: 'home',
  custodianAccountId: 'owner',
  launch: {
    provider: { pluginId: 'custom.provisioner', localId: 'native' },
    schemaVersion: 1,
    name: 'Guest',
    choices: {},
  },
  controller: { machineId: 'controller', installationId: 'installation' },
  allocation: 'bound',
  creationState: 'active',
  resource: {
    contributionRef: { pluginId: 'custom.provisioner', localId: 'native' },
    schemaVersion: 1,
    value: {},
  },
  desired: 'start',
  desiredWhen: 'now',
  intentRevision: 1,
  retention: { kind: 'until-delete' },
  wakeOnAcceptedMessage: false,
} satisfies ManagedMachineV1;

describe('managed creation presentation', () => {
  it('keeps Account-owned installation recovery separate from earlier controller operations', () => {
    const accountOwned = { ...machine, controller: undefined };
    const earlierControllerOperation: ActionOperationProjection = {
      serverId: machine.homeId, observation: 'available', isUnavailableProjection: false,
      snapshot: {
        version: 1, operationId: 'old-install', revision: 1,
        actionId: 'machines.managed.acquire', state: 'failed',
        scope: { accountId: machine.custodianAccountId, machineId: 'controller' },
        title: 'Install', createdAt: 1, settledAt: 2, cancellation: 'supported',
        domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource,
          controller: machine.controller },
        error: { errorCode: 'provider_unavailable', error: 'provider_unavailable' },
      },
    };
    expect(currentManagedCreationOperation(accountOwned, earlierControllerOperation)).toBeNull();
    expect(canRetryManagedInstallation(accountOwned)).toBe(true);
    expect(canRetryManagedInstallation(accountOwned, earlierControllerOperation)).toBe(false);
  });

  it('offers only the power actions the observed state allows, and none while an unenrolled resource has no observed power', () => {
    const intents: RetentionCapabilitiesV1['supportedIntents'] = ['start', 'suspend', 'resume', 'delete'];
    const observed = (power: 'running' | 'suspended') => ({ ...machine,
      observation: ProviderObservationV1Schema.parse({ availability: 'present', power, observedAt: 1 }) });
    // Installing or failed install: Happier has not seen its power, so Start beside Suspend would contradict itself.
    expect(managedReceiptPowerIntents(machine, intents)).toEqual([]);
    expect(managedReceiptPowerIntents(observed('running'), intents)).toEqual(['suspend']);
    expect(managedReceiptPowerIntents(observed('suspended'), intents)).toEqual(['resume']);
    // An observed resource whose provider reports no power, or an enrolled machine, keeps its explicit controls.
    const powerless = { ...machine, observation: ProviderObservationV1Schema.parse({ availability: 'present', observedAt: 1 }) };
    expect(managedReceiptPowerIntents(powerless, ['start', 'stop', 'delete'])).toEqual(['start', 'stop']);
    expect(managedReceiptPowerIntents({ ...machine, enrolledMachineId: 'guest' }, ['start', 'stop', 'delete'])).toEqual(['start', 'stop']);
  });
  it('reads a submitted creation whose acquire still runs as creating, not as a resource that may already exist', () => {
    const submitted: ManagedMachineV1 = { ...machine, allocation: 'may-exist', resource: undefined };
    const acquiring: ActionOperationProjection = {
      serverId: machine.homeId, observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'acquire', revision: 1, actionId: 'machines.managed.acquire',
        state: 'running', scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Create machine', createdAt: 10, startedAt: 10, cancellation: 'supported',
        domainRef: { kind: 'managedMachine', id: machine.id } },
    };
    expect(managedCreationState(submitted, { operation: acquiring }).kind).toBe('creating');
    // A last-known running acquire still reads as creating while its history reconnects.
    expect(managedCreationState(submitted, { operation: { ...acquiring, observation: 'reconnecting' } }).kind).toBe('creating');
    // Without a live acquire, Happier cannot say whether the native create landed.
    expect(managedCreationState(submitted).kind).toBe('mayExist');
    expect(managedCreationState(submitted, { operation: { ...acquiring, snapshot: { ...acquiring.snapshot, state: 'failed', settledAt: 20,
      error: { errorCode: 'action_failed', error: 'boom' } } } }).kind).toBe('mayExist');
  });
  it('explains a Home controller failure while preserving native installation diagnostics', () => {
    const progress = { kind: 'phase' as const, phase: 'ssh.installCli', label: 'Installing Happier' };
    for (const errorCode of ['database_connection_unavailable', 'database_transaction_conflict_exhausted', 'internal_error']) {
      expect(describeManagedInstallationFailure({ errorCode, error: errorCode,
        details: { kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/current',
          category: 'status', status: errorCode === 'internal_error' ? 500 : 503, code: errorCode } }, progress))
        .toBe(t('managedMachines.creation.homeRequestFailed'));
    }
    // The installer's own sentence is diagnostic detail, never the page's cause.
    expect(describeManagedInstallationFailure({ errorCode: 'provider_unavailable', error: 'Native command failed: GITHUB_TOKEN unset' }, progress))
      .toBeNull();
  });
  it.each(['managed_controller_request_failed', 'ECONNABORTED', 'admission_unavailable',
    'RPC_TRANSPORT_UNAVAILABLE', 'RPC_CLIENT_NOT_AVAILABLE'])
  ('retires a failed pre-effect idle observation (%s) only after newer healthy guest presence', (errorCode) => {
    const enrolled = { ...machine, enrolledMachineId: 'guest' };
    const failed: ActionOperationProjection = {
      serverId: machine.homeId, observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'idle-observation', revision: 2, actionId: 'machines.managed.power.set',
        state: 'failed', scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Change power', createdAt: 10, startedAt: 10, settledAt: 20, cancellation: 'supported',
        progress: { kind: 'phase', phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' },
        domainRef: { kind: 'managedMachine', id: machine.id, controller: machine.controller, resource: machine.resource },
        error: { errorCode, error: errorCode } },
    };
    const connected = { enrolledMachine: { machineId: 'guest', installationId: 'guest-installation', online: true,
      serviceManaged: true, activeAt: 30 } };
    expect(currentManagedCreationOperation(enrolled, failed, connected)).toBeNull();
    expect(currentManagedCreationOperation(enrolled, failed)).toBe(failed);
    for (const guest of [
      { ...connected.enrolledMachine, activeAt: 15 },
      { ...connected.enrolledMachine, online: false },
      { ...connected.enrolledMachine, machineId: 'another-guest' },
    ]) expect(currentManagedCreationOperation(enrolled, failed, { enrolledMachine: guest })).toBe(failed);
    // Current explicit Stop and native-effect failures still need attention.
    expect(currentManagedCreationOperation({ ...enrolled, desired: 'stop' }, failed, connected)).toBe(failed);
    expect(currentManagedCreationOperation({ ...enrolled, submittedNativeEffect: {
      intentRevision: 1, requestId: 'native-stop', intent: 'stop', controller: machine.controller,
    } }, failed, connected)).toBe(failed);
    expect(currentManagedCreationOperation(enrolled, { ...failed, snapshot: { ...failed.snapshot,
      progress: { kind: 'phase', phase: 'managed.intent.native-effect', label: 'Applying native machine intent' } } }, connected))
      .not.toBeNull();
    for (const refusal of ['credential_unavailable', 'RPC_FORBIDDEN']) {
      expect(currentManagedCreationOperation(enrolled, { ...failed, snapshot: { ...failed.snapshot,
        error: { errorCode: refusal, error: refusal } } }, connected)).not.toBeNull();
    }
    expect(currentManagedCreationOperation(enrolled, { ...failed, observation: 'unavailable', isUnavailableProjection: true }, connected))
      .not.toBeNull();
  });
  it('retires a historical failure after confirmed removal but keeps a later failed request', () => {
    const removed: ManagedMachineV1 = {
      ...machine,
      desired: 'delete',
      intentRevision: 3,
      allocation: 'confirmed-absent',
      observation: { availability: 'absent', observedAt: 30 },
    };
    const failed: ActionOperationProjection = {
      serverId: machine.homeId,
      observation: 'available',
      isUnavailableProjection: false,
      snapshot: {
        version: 1, operationId: 'earlier-request', revision: 2,
        actionId: 'machines.managed.delete', state: 'failed',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Delete', createdAt: 10, settledAt: 20, cancellation: 'supported',
        domainRef: { kind: 'managedMachine', id: machine.id,
          controller: machine.controller, resource: machine.resource },
        error: { errorCode: 'managed_controller_request_failed', error: 'managed_controller_request_failed' },
      },
    };
    expect(managedCreationState(removed, { operation: failed })).toEqual({ kind: 'absent' });
    expect(currentManagedCreationOperation(removed, failed)).toBeNull();
    // Retention started before Delete can settle after native absence. Its
    // settlement is not a new request against the removed resource.
    const retention = { ...failed, snapshot: { ...failed.snapshot,
      actionId: 'machines.managed.power.set' as const, settledAt: 40,
      progress: { kind: 'phase' as const, phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' },
    } };
    expect(currentManagedCreationOperation(removed, retention)).toBeNull();
    // Native absence can precede its Home report. A retention read admitted
    // in that gap is still not actionable once the removed row arrives.
    expect(currentManagedCreationOperation(removed, { ...retention, snapshot: { ...retention.snapshot,
      createdAt: 35, settledAt: 40 } })).toBeNull();
    const later = { ...failed, snapshot: { ...failed.snapshot, createdAt: 35, settledAt: 40 } };
    expect(currentManagedCreationOperation(removed, later)).toBe(later);
    expect(currentManagedCreationOperation(machine, failed)).toBe(failed);
    expect(currentManagedCreationOperation({ ...removed, observation: undefined }, failed)).toBe(failed);
    // Start and Stop observations must not erase a genuinely failed request.
    for (const [desired, power] of [['start', 'running'], ['stop', 'stopped']] as const) {
      const retained: ManagedMachineV1 = { ...machine, desired,
        observation: { availability: 'present', power, observedAt: 30 } };
      const powerFailure = { ...failed, snapshot: { ...failed.snapshot, actionId: 'machines.managed.power.set' as const } };
      expect(currentManagedCreationOperation(retained, powerFailure)).toBe(powerFailure);
    }
  });
  it('retires only the selected service activation failure after the enrolled guest connects', () => {
    const enrolled = {
      ...machine,
      enrolledMachineId: 'guest',
      preset: { id: 'preset', revision: 1 },
    };
    const operation: ActionOperationProjection = {
      serverId: machine.homeId,
      observation: 'available',
      isUnavailableProjection: false,
      snapshot: {
        version: 1,
        operationId: 'late-service',
        revision: 1,
        actionId: 'machines.managed.bootstrap.retry',
        state: 'failed',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Retry installation',
        createdAt: 1,
        settledAt: 2,
        domainRef: {
          kind: 'managedMachine',
          id: machine.id,
          resource: machine.resource,
          controller: machine.controller,
        },
        cancellation: 'supported',
        error: {
          errorCode: 'action_failed',
          error:
            'Background service install completed, but the expected background service did not become the active daemon for the selected Home within 30000ms. Run `happier service status` to inspect the active owner and system service state.',
        },
      },
    };
    const connected = {
      enrolledMachine: {
        machineId: 'guest',
        installationId: 'guest-installation',
        online: true,
        serviceManaged: true,
      },
    };
    expect(
      currentManagedCreationOperation(enrolled, operation, connected),
    ).toBeNull();
    expect(canRetryManagedInstallation(enrolled, operation, connected)).toBe(
      false,
    );
    expect(currentManagedCreationOperation(enrolled, operation)).toBe(
      operation,
    );
    expect(
      currentManagedCreationOperation(enrolled, operation, {
        enrolledMachine: { ...connected.enrolledMachine, online: false },
      }),
    ).toBe(operation);
    expect(
      currentManagedCreationOperation(enrolled, operation, {
        enrolledMachine: {
          ...connected.enrolledMachine,
          serviceManaged: false,
        },
      }),
    ).toBe(operation);
    expect(
      currentManagedCreationOperation(enrolled, operation, {
        enrolledMachine: {
          ...connected.enrolledMachine,
          machineId: 'another-guest',
        },
      }),
    ).toBe(operation);
    expect(
      currentManagedCreationOperation(enrolled, operation, {
        enrolledMachine: { ...connected.enrolledMachine, installationId: '' },
      }),
    ).toBe(operation);
    for (const error of [
      {
        errorCode: 'native_boot_unconfirmed',
        error: 'The native daemon boot configuration was not confirmed.',
      },
      { errorCode: 'credential_unavailable', error: 'Credential unavailable' },
      {
        errorCode: 'action_failed',
        error: 'The provider could not configure the guest.',
      },
    ])
      expect(
        currentManagedCreationOperation(
          enrolled,
          { ...operation, snapshot: { ...operation.snapshot, error } },
          connected,
        ),
      ).not.toBeNull();
    expect(
      currentManagedCreationOperation(
        enrolled,
        { ...operation, observation: 'unavailable' },
        connected,
      ),
    ).not.toBeNull();
    expect(
      currentManagedCreationOperation(
        enrolled,
        {
          ...operation,
          snapshot: {
            ...operation.snapshot,
            state: 'running',
            settledAt: undefined,
          },
        },
        connected,
      ),
    ).not.toBeNull();
    const setup = {
      ...operation,
      snapshot: {
        ...operation.snapshot,
        actionId: 'machines.environment.apply' as const,
        scope: { ...operation.snapshot.scope, machineId: 'guest' },
        domainRef: {
          kind: 'machineEnvironment' as const,
          serverId: machine.homeId,
          machineId: 'guest',
          managedId: machine.id,
          preset: enrolled.preset,
        },
      },
    };
    expect(currentManagedCreationOperation(enrolled, setup, connected)).toBe(
      setup,
    );
  });
  it('retires a failed acquire confirmation after the exact managed service connects', () => {
    const enrolled = { ...machine, enrolledMachineId: 'guest' };
    const operation: ActionOperationProjection = {
      serverId: machine.homeId,
      observation: 'available',
      isUnavailableProjection: false,
      snapshot: {
        version: 1,
        operationId: 'late-controller-confirmation',
        revision: 1,
        actionId: 'machines.managed.acquire',
        state: 'failed',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Create machine',
        createdAt: 1,
        settledAt: 2,
        domainRef: {
          kind: 'managedMachine',
          id: machine.id,
          resource: machine.resource,
          controller: machine.controller,
        },
        cancellation: 'supported',
        error: {
          errorCode: 'managed_controller_request_failed',
          error: 'The managing computer could not confirm the completed installation.',
          details: {
            kind: 'managedControllerRequest',
            path: '/v1/machines/managed/controller/current',
            category: 'schema',
            status: 200,
          },
        },
      },
    };
    const connected = {
      enrolledMachine: {
        machineId: 'guest',
        installationId: 'guest-installation',
        online: true,
        serviceManaged: true,
      },
    };

    expect(currentManagedCreationOperation(enrolled, operation, connected)).toBeNull();
    expect(canRetryManagedInstallation(enrolled, operation, connected)).toBe(false);
    expect(currentManagedCreationOperation(enrolled, operation)).toBe(operation);
    expect(currentManagedCreationOperation(enrolled, operation, {
      enrolledMachine: { ...connected.enrolledMachine, online: false },
    })).toBe(operation);
    expect(currentManagedCreationOperation(enrolled, {
      ...operation,
      snapshot: {
        ...operation.snapshot,
        actionId: 'machines.managed.bootstrap.retry',
      },
    }, connected)).not.toBeNull();
    expect(currentManagedCreationOperation(enrolled, {
      ...operation,
      snapshot: {
        ...operation.snapshot,
        error: { errorCode: 'credential_unavailable', error: 'Credential unavailable' },
      },
    }, connected)).not.toBeNull();
  });
  it('recovers a retained unenrolled resource after controller operation history is lost', () => {
    const retained: ManagedMachineV1 = {
      ...machine,
      preset: { id: 'admitted-preset', revision: 1 },
      observation: { availability: 'present', power: 'running', observedAt: 1 },
      environmentSetup: {
        environment: { setupScript: 'echo setup' },
        state: 'pending',
      },
    };
    expect(canRetryManagedInstallation(retained, null)).toBe(true);
    expect(
      canRetryManagedInstallation(retained, null, { providerAvailable: false }),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(
        { ...retained, enrolledMachineId: 'guest' },
        null,
      ),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(
        { ...retained, creationState: 'canceled' },
        null,
      ),
    ).toBe(false);
    expect(
      canRetryManagedInstallation({ ...retained, archivedAt: 2 }, null),
    ).toBe(false);
    expect(
      canRetryManagedInstallation({ ...retained, desired: 'delete' }, null),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(
        {
          ...retained,
          cleanup: { disposition: 'pending', reason: 'late_allocation' },
        },
        null,
      ),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(
        { ...retained, allocation: 'may-exist', resource: undefined },
        null,
      ),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(
        { ...retained, observation: { availability: 'absent', observedAt: 2 } },
        null,
      ),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(
        {
          ...retained,
          observation: {
            availability: 'present',
            storage: 'lost',
            observedAt: 2,
          },
        },
        null,
      ),
    ).toBe(false);
  });
  it('offers installation recovery after the provider becomes available without borrowing a replaced resource failure', () => {
    const operation: ActionOperationProjection = {
      serverId: machine.homeId,
      observation: 'available',
      isUnavailableProjection: false,
      snapshot: {
        version: 1,
        operationId: 'provider-failure',
        revision: 1,
        actionId: 'machines.managed.bootstrap.retry',
        state: 'failed',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Retry installation',
        createdAt: 1,
        settledAt: 2,
        domainRef: {
          kind: 'managedMachine',
          id: machine.id,
          resource: machine.resource,
          controller: machine.controller,
        },
        cancellation: 'supported',
        error: {
          errorCode: 'provider_unavailable',
          error: 'Provider unavailable',
        },
      },
    };
    expect(
      managedCreationState(machine, { providerAvailable: false }).kind,
    ).toBe('providerRemoved');
    expect(
      managedCreationState(machine, { providerAvailable: true }).kind,
    ).toBe('resourceReady');
    expect(canRetryManagedInstallation(machine, operation)).toBe(true);
    expect(
      canRetryManagedInstallation(
        {
          ...machine,
          resource: {
            ...machine.resource!,
            value: { nativeId: 'replacement' },
          },
        },
        operation,
      ),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(machine, {
        ...operation,
        snapshot: {
          ...operation.snapshot,
          error: {
            errorCode: 'credential_unavailable',
            error: 'Credential unavailable',
          },
        },
      }),
    ).toBe(false);
    expect(
      canRetryManagedInstallation(machine, {
        ...operation,
        observation: 'unavailable',
      }),
    ).toBe(false);
  });
  it('keeps an unenrolled resource retryable after a later power operation replaces the visible operation', () => {
    const powerOperation: ActionOperationProjection = {
      serverId: machine.homeId,
      observation: 'available',
      isUnavailableProjection: false,
      snapshot: {
        version: 1,
        operationId: 'resume-after-install-failure',
        revision: 1,
        actionId: 'machines.managed.power.set',
        state: 'succeeded',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Resume machine',
        createdAt: 3,
        startedAt: 3,
        settledAt: 4,
        cancellation: 'supported',
        domainRef: {
          kind: 'managedMachine',
          id: machine.id,
          resource: machine.resource,
          controller: machine.controller,
        },
        result: { kind: 'accepted' },
      },
    };
    expect(canRetryManagedInstallation(machine, powerOperation)).toBe(true);
  });
  it.each([
    ['managed.intent.busy', 'busy'],
    ['managed.intent.activity-unknown', 'activityUnknown'],
    ['managed.intent.draining', 'draining'],
  ] as const)(
    'projects %s only from the available current resource operation',
    (phase, kind) => {
      const operation: ActionOperationProjection = {
        serverId: machine.homeId,
        observation: 'available',
        isUnavailableProjection: false,
        snapshot: {
          version: 1,
          operationId: 'retention-operation',
          revision: 1,
          actionId: 'machines.managed.delete',
          state: 'running',
          scope: {
            accountId: 'owner',
            machineId: machine.controller.machineId,
          },
          title: 'Delete',
          createdAt: 1,
          startedAt: 2,
          domainRef: {
            kind: 'managedMachine',
            id: machine.id,
            resource: machine.resource,
            controller: machine.controller,
          },
          cancellation: 'supported',
          progress: { kind: 'phase', phase, label: 'Observed guest activity' },
        },
      };
      expect(managedCreationState(machine, { operation })).toEqual({ kind });
      expect(
        managedCreationState(machine, {
          operation: { ...operation, observation: 'unavailable' },
        }),
      ).toEqual({ kind: 'resourceReady' });
      expect(
        managedCreationState(
          {
            ...machine,
            resource: {
              ...machine.resource!,
              value: { nativeId: 'replacement' },
            },
          },
          { operation },
        ),
      ).toEqual({ kind: 'resourceReady' });
      expect(
        managedCreationState(machine, {
          operation: {
            ...operation,
            snapshot: {
              ...operation.snapshot,
              state: 'succeeded',
              settledAt: 3,
            },
          },
        }),
      ).toEqual({ kind: 'resourceReady' });
    },
  );
  it('projects setup only after Join and offers recovery only for the same live failed setup', () => {
    const setup = {
      environment: { setupScript: 'echo setup' },
      state: 'failed' as const,
      operation: { operationId: 'setup-operation' },
      errorCode: 'setup_failed',
    };
    expect(
      managedCreationSetup({
        ...machine,
        environmentSetup: { ...setup, state: 'pending', errorCode: undefined },
      }),
    ).toBeNull();
    expect(
      managedCreationSetup({
        ...machine,
        enrolledMachineId: 'guest',
        environmentSetup: setup,
      }),
    ).toMatchObject({
      state: 'failed',
      operation: { operationId: 'setup-operation' },
      errorCode: 'setup_failed',
      recoveryActions: ['retrySetup', 'continueWithoutSetup', 'delete'],
    });
    expect(
      managedCreationSetup({
        ...machine,
        enrolledMachineId: 'guest',
        environmentSetup: { ...setup, state: 'skipped', errorCode: undefined },
      }),
    ).toMatchObject({ state: 'skipped', recoveryActions: [] });
    expect(
      managedCreationSetup({
        ...machine,
        enrolledMachineId: 'guest',
        allocation: 'confirmed-absent',
        environmentSetup: setup,
      }),
    ).toMatchObject({ recoveryActions: [] });
  });
  it('does not manufacture a running or failed installation from a bound resource', () => {
    expect(describeManagedCreation(machine)).toMatchObject({
      line: t('managedMachines.creation.resourceReady'),
      tone: 'neutral',
    });
    expect(
      describeManagedCreation({
        ...machine,
        observation: { availability: 'unavailable', observedAt: 1 },
      }).line,
    ).not.toBe(t('managedPower.resourceAbsent'));
    expect(
      describeManagedCreation({
        ...machine,
        allocation: 'may-exist',
        resource: undefined,
      }).line,
    ).toBe(
      `${t('managedMachines.creation.unknownCause', { name: 'Guest' })} ${t('managedMachines.creation.unknownDetail')}`,
    );
  });
  it('waits for an offline controller by name before anything is created, and names the provider it confirms with', () => {
    const unsubmitted = {
      ...machine,
      allocation: 'unsubmitted' as const,
      resource: undefined,
    };
    expect(
      managedCreationState(unsubmitted, {
        controller: { name: 'MacBook Pro', online: false },
        provider: 'Hetzner',
      }),
    ).toEqual({
      kind: 'controllerWaiting',
      name: 'Guest',
      controller: 'MacBook Pro',
      provider: 'Hetzner',
    });
    expect(
      managedCreationState(unsubmitted, {
        controller: { name: 'MacBook Pro', online: true },
        provider: 'Hetzner',
      }),
    ).toEqual({ kind: 'creationWaiting', name: 'Guest' });
    expect(managedCreationState(unsubmitted)).toEqual({
      kind: 'creationWaiting',
      name: 'Guest',
    });
  });
  it('keeps cancellation cleanup visible and only treats confirmed absence as ended', () => {
    const canceled = {
      ...machine,
      creationState: 'canceled' as const,
      cleanup: { disposition: 'pending' as const, reason: 'late_allocation' },
    };
    expect(describeManagedCreation(canceled)).toMatchObject({
      line: t('managedMachines.creation.canceledCleanup'),
      tone: 'warning',
    });
    expect(
      describeManagedCreation({
        ...canceled,
        allocation: 'confirmed-absent',
        cleanup: undefined,
      }).line,
    ).toBe(t('managedPower.resourceAbsent'));
  });
  it('reopens an enrolled managed URL through the ordinary Machine owner in its original Home', () => {
    expect(managedMachineDestination(machine, 'srv/a')).toBeNull();
    expect(
      managedMachineDestination(
        { ...machine, enrolledMachineId: 'joined machine' },
        'srv/a',
      ),
    ).toBe('/machines/joined%20machine?serverId=srv%2Fa');
  });
  it('keeps submitted Stop pending until observed stopped, and never treats lost storage as offline', () => {
    const pending = {
      ...machine,
      desired: 'stop' as const,
      submittedNativeEffect: {
        intentRevision: 1,
        requestId: 'stop-request',
        intent: 'stop' as const,
        controller: machine.controller,
      },
      observation: {
        availability: 'present' as const,
        observedAt: 10,
        power: 'running' as const,
        storage: 'retained' as const,
      },
    };
    expect(managedCreationState(pending)).toEqual({ kind: 'stopPending' });
    expect(
      managedCreationState({
        ...pending,
        submittedNativeEffect: undefined,
        observation: ProviderObservationV1Schema.parse({
          ...pending.observation,
          power: 'stopped',
          billing: { location: 'local', stoppedBilling: 'not-billed' },
        }),
      }),
    ).toEqual({ kind: 'stoppedStorage' });
    expect(
      managedCreationState({
        ...machine,
        observation: {
          availability: 'present',
          observedAt: 20,
          power: 'stopped',
          storage: 'lost',
        },
      }),
    ).toEqual({ kind: 'volumeLost' });
  });
  it('keeps a submitted Start pending while the last observation still says stopped', () => {
    const starting: ManagedMachineV1 = {
      ...machine,
      desired: 'start',
      submittedNativeEffect: {
        intentRevision: 1,
        requestId: 'start-request',
        intent: 'start',
        controller: machine.controller,
      },
      observation: {
        availability: 'present',
        observedAt: 10,
        power: 'stopped',
        storage: 'retained',
      },
    };
    expect(managedCreationState(starting).kind).toBe('powerPending');
    expect(
      managedCreationState(starting, { provider: 'Hetzner' }),
    ).toMatchObject({ kind: 'powerPending', provider: 'Hetzner' });
    expect(
      managedCreationState({
        ...starting,
        observation: { ...starting.observation!, power: 'running' },
      }).kind,
    ).toBe('resourceReady');
  });
  it('reads a retained Start as requested, not as a stopped machine at rest, until power is observed running', () => {
    // QB118: a committed Start whose native submission is unconfirmed has no submitted effect yet.
    const retained: ManagedMachineV1 = {
      ...machine,
      desired: 'start',
      observation: {
        availability: 'present',
        observedAt: 10,
        power: 'stopped',
        storage: 'retained',
      },
    };
    expect(managedCreationState(retained, { provider: 'Lima' })).toMatchObject({
      kind: 'powerPending',
      provider: 'Lima',
    });
    expect(managedCreationState({ ...retained, desired: 'stop' }).kind).toBe(
      'stoppedStorage',
    );
    expect(
      managedCreationState({
        ...retained,
        observation: { ...retained.observation!, power: 'running' },
      }).kind,
    ).toBe('resourceReady');
    // A freshly created machine has no power observation yet and keeps its creation reading.
    expect(managedCreationState({ ...machine, desired: 'start' }).kind).toBe(
      'resourceReady',
    );
  });
});

describe('managedPowerExplainsOffline (UIR5)', () => {
  it('lets an observed stopped or suspended created machine own its offline explanation, never a running or unknown one', () => {
    const observed = (
      power: 'running' | 'stopped' | 'suspended' | 'unknown',
    ): ManagedMachineV1 => ({
      ...machine,
      observation: { availability: 'present', observedAt: 1, power },
    });
    expect(managedPowerExplainsOffline(observed('stopped'))).toBe(true);
    expect(managedPowerExplainsOffline(observed('suspended'))).toBe(true);
    expect(managedPowerExplainsOffline(observed('running'))).toBe(false);
    expect(managedPowerExplainsOffline(observed('unknown'))).toBe(false);
    expect(managedPowerExplainsOffline(machine)).toBe(false);
    expect(managedPowerExplainsOffline(undefined)).toBe(false);
    expect(
      managedPowerExplainsOffline({
        ...observed('stopped'),
        creationState: 'retired',
      }),
    ).toBe(false);
  });
});
