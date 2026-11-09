import { describe, expect, it } from 'vitest';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import {
  canRetryManagedInstallation,
  currentManagedCreationOperation,
  describeManagedCreation,
  describeManagedInstallationFailure,
  managedCreationStages,
  managedCreationState,
  managedMachineEnrolledDetailId,
  managedCreationSetup,
  managedReceiptPowerIntents,
  isManagedCreationStateRowVisible,
} from './managedCreationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import {
  ProviderObservationV1Schema,
  type RetentionCapabilitiesV1,
} from '@happier-dev/protocol/machines/managed/providerFactsV1';

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
  it('names the unreachable guest Home in the shared creation failure message', () => {
    const homeOrigin = 'https://home.example.test:9443';
    const failure = describeManagedInstallationFailure({ errorCode: 'home_not_guest_reachable',
      error: 'private installer diagnostic', details: { kind: 'managedGuestHome', homeOrigin } }, undefined);
    expect(failure).toContain(homeOrigin);
    expect(failure).toContain(t('managedMachines.creation.homeNotGuestReachable'));
    expect(failure).not.toContain('private installer diagnostic');
  });
  it('keeps enrolled bootstrap recovery available after a passive receipt displaces Create', () => {
    const incomplete: ManagedMachineV1 = { ...machine, enrolledMachineId: 'guest', bootstrapInstalled: true,
      observation: { observedAt: 3, availability: 'unavailable', reason: 'bootstrap.incomplete' } };
    const retention: ActionOperationProjection = { serverId: machine.homeId, observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'retention', revision: 1, actionId: 'machines.managed.power.set', state: 'running',
        scope: { accountId: machine.custodianAccountId, machineId: 'controller' }, title: 'Retention', createdAt: 4,
        cancellation: 'supported', progress: { kind: 'phase', phase: 'managed.intent.busy', label: 'Waiting for unused machine' },
        domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller } } };
    expect(canRetryManagedInstallation(incomplete, retention)).toBe(true);
    expect(canRetryManagedInstallation(incomplete)).toBe(true);
    expect(canRetryManagedInstallation({ ...incomplete, observation: { observedAt: 5, availability: 'present' } }, retention)).toBe(false);
    expect(canRetryManagedInstallation({ ...incomplete, desired: 'delete' }, retention)).toBe(false);
    expect(canRetryManagedInstallation(incomplete, retention, { providerAvailable: false })).toBe(false);
    const installing: ActionOperationProjection = { ...retention, snapshot: { ...retention.snapshot, actionId: 'machines.managed.bootstrap.retry' } };
    expect(canRetryManagedInstallation(incomplete, installing)).toBe(false);
  });
  it.each([false, true])('distinguishes nothing created from an ended bound resource (resource known: %s)', resourceKnown => {
    const absent: ManagedMachineV1 = { ...machine, allocation: 'confirmed-absent', resource: resourceKnown ? machine.resource : undefined };
    expect(managedCreationState(absent)).toEqual({ kind: resourceKnown ? 'absent' : 'notCreated' });
    expect(describeManagedCreation(absent).line).toBe(t(resourceKnown ? 'managedPower.resourceAbsent' : 'managedMachines.inspect.notCreated'));
    expect(describeManagedCreation(absent).actions).not.toContain('checkNow');
    expect(canRetryManagedInstallation(absent)).toBe(false);
  });
  it.each(['active', 'canceled'] as const)('offers responsibility review when %s cleanup cannot be verified', creationState => {
    const unavailable: ManagedMachineV1 = { ...machine, creationState, desired: 'delete',
      cleanup: { disposition: 'unavailable', reason: 'credential_unavailable' } };
    expect(describeManagedCreation(unavailable).actions).toContain('remove');
    expect(managedCreationState(unavailable).kind).toBe('cleanupUnknown');
  });
  it('offers manual removal while canceled creation cleanup cannot be confirmed', () => {
    const canceled: ManagedMachineV1 = { ...machine, creationState: 'canceled', allocation: 'may-exist', resource: undefined,
      desired: 'delete', cleanup: { disposition: 'pending', reason: 'creation_canceled' } };
    expect(describeManagedCreation(canceled).actions).toContain('remove');
  });
  it('does not bind a healthy Keep idle-wait to the creation card', () => {
    const operation: ActionOperationProjection = { serverId: 'home', observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'keep', revision: 1, actionId: 'machines.managed.power.set',
        state: 'running', scope: { accountId: 'owner', machineId: 'controller' }, title: 'Keep', createdAt: 1,
        cancellation: 'supported', progress: { kind: 'phase', phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' },
        domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller } } };
    expect(currentManagedCreationOperation(machine, operation)).toBeNull();
  });
  it('does not offer a wake action when the enrolled machine is online without native power observation', () => {
    expect(managedReceiptPowerIntents({ ...machine, enrolledMachineId: 'guest' }, ['start', 'stop', 'delete'],
      { machineId: 'guest', online: true })).toEqual(['stop']);
  });
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
    const intents: RetentionCapabilitiesV1['supportedIntents'] = [
      'start',
      'suspend',
      'resume',
      'delete',
    ];
    const observed = (power: 'running' | 'suspended') => ({
      ...machine,
      observation: ProviderObservationV1Schema.parse({
        availability: 'present',
        power,
        observedAt: 1,
      }),
    });
    // Installing or failed install: Happier has not seen its power, so Start beside Suspend would contradict itself.
    expect(managedReceiptPowerIntents(machine, intents)).toEqual([]);
    expect(managedReceiptPowerIntents(observed('running'), intents)).toEqual([
      'suspend',
    ]);
    expect(managedReceiptPowerIntents(observed('suspended'), intents)).toEqual([
      'resume',
    ]);
  });
  it('leaves the joined machine state to its header while retaining its freshness', () => {
    const stopped = { ...machine, enrolledMachineId: 'guest', desired: 'stop' as const,
      observation: ProviderObservationV1Schema.parse({ availability: 'present', observedAt: 1, power: 'stopped', storage: 'retained' }) };
    expect(isManagedCreationStateRowVisible(stopped, managedCreationState(stopped))).toBe(false);
    // Before it joins, nothing else says it: the row stays.
    const unjoined = { ...stopped, enrolledMachineId: undefined };
    expect(isManagedCreationStateRowVisible(unjoined, managedCreationState(unjoined))).toBe(true);
  });
  it('keeps the row of a joined stopped machine when it offers Start', () => {
    const stopped = { ...machine, enrolledMachineId: 'guest', desired: 'stop' as const,
      observation: ProviderObservationV1Schema.parse({ availability: 'present', observedAt: 1, power: 'stopped', storage: 'retained' }) };
    expect(isManagedCreationStateRowVisible(stopped, managedCreationState(stopped), { offersStart: true })).toBe(true);
    expect(isManagedCreationStateRowVisible(stopped, managedCreationState(stopped), { offersStart: false })).toBe(false);
  });
  it.each(['stopped', 'suspended'] as const)('offers wake after native %s while enrolled presence still says online', power => {
    const parked = { ...machine, enrolledMachineId: 'guest', desired: power === 'stopped' ? 'stop' as const : 'suspend' as const,
      observation: ProviderObservationV1Schema.parse({ availability: 'present', observedAt: 2, power, storage: 'retained' }) };
    expect(managedReceiptPowerIntents(parked, ['start', 'stop', 'suspend', 'resume'],
      { machineId: 'guest', online: true })).toEqual([power === 'stopped' ? 'start' : 'resume']);
  });
  it('never offers opposite power actions while power is unknown, and one action once it is observed', () => {
    const intents: RetentionCapabilitiesV1['supportedIntents'] = ['start', 'stop', 'delete'];
    const at = (power?: 'running' | 'stopped' | 'unknown') => ProviderObservationV1Schema.parse({
      availability: 'present', observedAt: 1, ...(power ? { power } : {}),
    });
    // Unknown, unreported or not yet observed power: Check now reads it first; no Start beside Stop.
    expect(managedReceiptPowerIntents({ ...machine, observation: at() }, intents)).toEqual([]);
    expect(managedReceiptPowerIntents({ ...machine, observation: at('unknown') }, intents)).toEqual([]);
    expect(managedReceiptPowerIntents({ ...machine, enrolledMachineId: 'guest' }, intents)).toEqual([]);
    expect(managedReceiptPowerIntents({ ...machine, enrolledMachineId: 'guest' }, intents,
      { machineId: 'guest', online: false })).toEqual([]);
    // Observed stopped at rest: Start alone.
    expect(managedReceiptPowerIntents({ ...machine, desired: 'stop', observation: at('stopped') }, intents)).toEqual(['start']);
    expect(managedReceiptPowerIntents({ ...machine, enrolledMachineId: 'guest', desired: 'stop', observation: at('stopped') }, intents)).toEqual(['start']);
    // Completed desired intent is history; only a submitted effect is pending (MACH-AUDIT-SPLIT F1).
    expect(managedReceiptPowerIntents({ ...machine, enrolledMachineId: 'guest', observation: at('stopped') }, intents)).toEqual(['start']);
    expect(managedReceiptPowerIntents({ ...machine, observation: at('stopped'),
      submittedNativeEffect: { intentRevision: 1, requestId: 'wake', intent: 'start' } }, intents)).toEqual(['stop']);
    // Observed running: Stop alone.
    expect(managedReceiptPowerIntents({ ...machine, observation: at('running') }, intents)).toEqual(['stop']);
  });
  it('offers Resume after a completed wake is followed by provider-side Suspend', () => {
    const parked = { ...machine, desired: 'resume' as const, enrolledMachineId: 'guest',
      observation: ProviderObservationV1Schema.parse({ availability: 'present', observedAt: 2, power: 'suspended', storage: 'retained' }) };
    expect(managedCreationState(parked).kind).not.toBe('powerPending');
    expect(managedReceiptPowerIntents(parked, ['resume', 'suspend'])).toEqual(['resume']);
    const submitted = { ...parked, submittedNativeEffect: { intentRevision: 2, requestId: 'resume', intent: 'resume' as const } };
    expect(managedCreationState(submitted).kind).toBe('powerPending');
    expect(managedReceiptPowerIntents(submitted, ['resume', 'suspend'])).toEqual([]);
  });
  it('reads a submitted creation whose acquire still runs as creating, not as a resource that may already exist', () => {
    const submitted: ManagedMachineV1 = {
      ...machine,
      allocation: 'may-exist',
      resource: undefined,
    };
    const acquiring: ActionOperationProjection = {
      serverId: machine.homeId,
      observation: 'available',
      isUnavailableProjection: false,
      snapshot: {
        version: 1,
        operationId: 'acquire',
        revision: 1,
        actionId: 'machines.managed.acquire',
        state: 'running',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Create machine',
        createdAt: 10,
        startedAt: 10,
        cancellation: 'supported',
        domainRef: { kind: 'managedMachine', id: machine.id },
      },
    };
    expect(managedCreationState(submitted, { operation: acquiring }).kind).toBe(
      'creating',
    );
    // REVIEW-MAIN-A.md P3-2 and FIX-PRESETS follow-up: an unavailable/unknown receipt
    // cannot establish creating, even when its retained snapshot says running.
    for (const operation of [
      { ...acquiring, observation: 'reconnecting' as const },
      { ...acquiring, observation: 'unavailable' as const },
      { ...acquiring, isUnavailableProjection: true },
    ])
      expect(managedCreationState(submitted, { operation }).kind).toBe(
        'mayExist',
      );
    // Without a live acquire, Happier cannot say whether the native create landed.
    expect(managedCreationState(submitted).kind).toBe('mayExist');
    expect(
      managedCreationState(submitted, {
        operation: {
          ...acquiring,
          snapshot: {
            ...acquiring.snapshot,
            state: 'failed',
            settledAt: 20,
            error: { errorCode: 'action_failed', error: 'boom' },
          },
        },
      }).kind,
    ).toBe('mayExist');
    const rejected: ActionOperationProjection = {
      ...acquiring,
      snapshot: {
        ...acquiring.snapshot,
        state: 'failed',
        settledAt: 20,
        error: {
          errorCode: 'provider_unavailable',
          error: 'provider_unavailable',
        },
      },
    };
    const absent = { ...submitted, allocation: 'confirmed-absent' as const };
    expect(currentManagedCreationOperation(absent, rejected)).toBe(rejected);
    // An id-only failure cannot stand in for a bound resource or a failed same-resource installation.
    expect(currentManagedCreationOperation(machine, rejected)).toBeNull();
    expect(
      currentManagedCreationOperation(absent, {
        ...rejected,
        snapshot: {
          ...rejected.snapshot,
          actionId: 'machines.managed.bootstrap.retry',
        },
      }),
    ).toBeNull();
    expect(currentManagedCreationOperation(absent, acquiring)).toBeNull();
  });
  it('explains a Home controller failure while preserving native installation diagnostics', () => {
    const progress = {
      kind: 'phase' as const,
      phase: 'ssh.installCli',
      label: 'Installing Happier',
    };
    expect(
      describeManagedInstallationFailure(
        {
          errorCode: 'database_transaction_timeout',
          error: 'database_transaction_timeout',
        },
        progress,
      ),
    ).toBe(t('managedMachines.creation.homeRequestFailed'));
    for (const errorCode of [
      'database_connection_unavailable',
      'database_transaction_conflict_exhausted',
      'database_transaction_timeout',
      'internal_error',
    ]) {
      expect(
        describeManagedInstallationFailure(
          {
            errorCode,
            error: errorCode,
            details: {
              kind: 'managedControllerRequest',
              path: '/v1/machines/managed/controller/current',
              category: 'status',
              status: errorCode === 'internal_error' ? 500 : 503,
              code: errorCode,
            },
          },
          progress,
        ),
      ).toBe(t('managedMachines.creation.homeRequestFailed'));
    }
    // The installer's own sentence is diagnostic detail, never the page's cause.
    expect(
      describeManagedInstallationFailure(
        {
          errorCode: 'provider_unavailable',
          error: 'Native command failed: GITHUB_TOKEN unset',
        },
        progress,
      ),
    ).toBeNull();
  });
  it('says a Home the new machine cannot reach in plain words, whether the refusal carries its code or only names it', () => {
    const progress = {
      kind: 'phase' as const,
      phase: 'acquire',
      label: 'Creating',
    };
    const sentence = t('managedMachines.creation.homeNotGuestReachable');
    expect(
      describeManagedInstallationFailure(
        {
          errorCode: 'home_not_guest_reachable',
          error: 'home_not_guest_reachable',
        },
        progress,
      ),
    ).toBe(sentence);
    // The executor reports a refusal outside the typed controller codes as `action_failed` with the code as its message.
    expect(
      describeManagedInstallationFailure(
        { errorCode: 'action_failed', error: 'home_not_guest_reachable' },
        progress,
      ),
    ).toBe(sentence);
    expect(
      describeManagedInstallationFailure(
        { errorCode: 'action_failed', error: 'boom' },
        progress,
      ),
    ).toBeNull();
  });
  it.each([
    'managed_controller_request_failed',
    'ECONNABORTED',
    'admission_unavailable',
    'RPC_TRANSPORT_UNAVAILABLE',
    'RPC_CLIENT_NOT_AVAILABLE',
  ])(
    'retires a failed pre-effect idle observation (%s) only after newer healthy guest presence',
    (errorCode) => {
      const enrolled = { ...machine, enrolledMachineId: 'guest' };
      const failed: ActionOperationProjection = {
        serverId: machine.homeId,
        observation: 'available',
        isUnavailableProjection: false,
        snapshot: {
          version: 1,
          operationId: 'idle-observation',
          revision: 2,
          actionId: 'machines.managed.power.set',
          state: 'failed',
          scope: {
            accountId: 'owner',
            machineId: machine.controller.machineId,
          },
          title: 'Change power',
          createdAt: 10,
          startedAt: 10,
          settledAt: 20,
          cancellation: 'supported',
          progress: {
            kind: 'phase',
            phase: 'managed.intent.waiting-idle',
            label: 'Waiting for unused machine',
          },
          domainRef: {
            kind: 'managedMachine',
            id: machine.id,
            controller: machine.controller,
            resource: machine.resource,
          },
          error: { errorCode, error: errorCode },
        },
      };
      const connected = {
        enrolledMachine: {
          machineId: 'guest',
          installationId: 'guest-installation',
          online: true,
          serviceManaged: true,
          activeAt: 30,
        },
      };
      expect(
        currentManagedCreationOperation(enrolled, failed, connected),
      ).toBeNull();
      expect(currentManagedCreationOperation(enrolled, failed)).toBe(failed);
      for (const guest of [
        { ...connected.enrolledMachine, activeAt: 15 },
        { ...connected.enrolledMachine, online: false },
        { ...connected.enrolledMachine, machineId: 'another-guest' },
      ])
        expect(
          currentManagedCreationOperation(enrolled, failed, {
            enrolledMachine: guest,
          }),
        ).toBe(failed);
      // Current explicit Stop and native-effect failures still need attention.
      expect(
        currentManagedCreationOperation(
          { ...enrolled, desired: 'stop' },
          failed,
          connected,
        ),
      ).toBe(failed);
      expect(
        currentManagedCreationOperation(
          {
            ...enrolled,
            submittedNativeEffect: {
              intentRevision: 1,
              requestId: 'native-stop',
              intent: 'stop',
              controller: machine.controller,
            },
          },
          failed,
          connected,
        ),
      ).toBe(failed);
      expect(
        currentManagedCreationOperation(
          enrolled,
          {
            ...failed,
            snapshot: {
              ...failed.snapshot,
              progress: {
                kind: 'phase',
                phase: 'managed.intent.native-effect',
                label: 'Applying native machine intent',
              },
            },
          },
          connected,
        ),
      ).not.toBeNull();
      for (const refusal of ['credential_unavailable', 'RPC_FORBIDDEN']) {
        expect(
          currentManagedCreationOperation(
            enrolled,
            {
              ...failed,
              snapshot: {
                ...failed.snapshot,
                error: { errorCode: refusal, error: refusal },
              },
            },
            connected,
          ),
        ).not.toBeNull();
      }
      expect(
        currentManagedCreationOperation(
          enrolled,
          {
            ...failed,
            observation: 'unavailable',
            isUnavailableProjection: true,
          },
          connected,
        ),
      ).not.toBeNull();
    },
  );
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
        version: 1,
        operationId: 'earlier-request',
        revision: 2,
        actionId: 'machines.managed.delete',
        state: 'failed',
        scope: { accountId: 'owner', machineId: machine.controller.machineId },
        title: 'Delete',
        createdAt: 10,
        settledAt: 20,
        cancellation: 'supported',
        domainRef: {
          kind: 'managedMachine',
          id: machine.id,
          controller: machine.controller,
          resource: machine.resource,
        },
        error: {
          errorCode: 'managed_controller_request_failed',
          error: 'managed_controller_request_failed',
        },
      },
    };
    expect(managedCreationState(removed, { operation: failed })).toEqual({
      kind: 'absent',
    });
    expect(currentManagedCreationOperation(removed, failed)).toBeNull();
    // Retention started before Delete can settle after native absence. Its
    // settlement is not a new request against the removed resource.
    const retention = {
      ...failed,
      snapshot: {
        ...failed.snapshot,
        actionId: 'machines.managed.power.set' as const,
        settledAt: 40,
        progress: {
          kind: 'phase' as const,
          phase: 'managed.intent.waiting-idle',
          label: 'Waiting for unused machine',
        },
      },
    };
    expect(currentManagedCreationOperation(removed, retention)).toBeNull();
    // Native absence can precede its Home report. A retention read admitted
    // in that gap is still not actionable once the removed row arrives.
    expect(
      currentManagedCreationOperation(removed, {
        ...retention,
        snapshot: { ...retention.snapshot, createdAt: 35, settledAt: 40 },
      }),
    ).toBeNull();
    const later = {
      ...failed,
      snapshot: { ...failed.snapshot, createdAt: 35, settledAt: 40 },
    };
    expect(currentManagedCreationOperation(removed, later)).toBe(later);
    expect(currentManagedCreationOperation(machine, failed)).toBe(failed);
    expect(
      currentManagedCreationOperation(
        { ...removed, observation: undefined },
        failed,
      ),
    ).toBe(failed);
    // Cancellation before submission confirms absence without a provider read.
    // Hydrated acquire history must not resurrect its obsolete failure card.
    const canceled: ManagedMachineV1 = {
      ...removed,
      creationState: 'canceled',
      resource: undefined,
      observation: undefined,
    };
    const acquiring = {
      ...failed,
      snapshot: {
        ...failed.snapshot,
        actionId: 'machines.managed.acquire' as const,
        domainRef: { kind: 'managedMachine' as const, id: machine.id },
        error: {
          errorCode: 'action_failed',
          error: 'saved_secret_account_lifetime_changed',
        },
      },
    };
    // Nothing was ever made: it reads as a request canceled before creation, not a resource that "no longer exists".
    expect(managedCreationState(canceled, { operation: acquiring })).toEqual({
      kind: 'creationCanceled',
    });
    expect(describeManagedCreation(canceled)).toMatchObject({
      line: t('managedMachines.creation.canceledBeforeCreate'),
      word: t('managedMachines.creation.canceledShort'),
      tone: 'neutral',
    });
    expect(currentManagedCreationOperation(canceled, acquiring)).toBeNull();
    expect(
      currentManagedCreationOperation(
        {
          ...canceled,
          allocation: 'unsubmitted',
          creationState: 'active',
          desired: 'start',
        },
        acquiring,
      ),
    ).toBe(acquiring);
    // Native absence without cancellation still lets a rejected acquire explain it.
    expect(
      currentManagedCreationOperation(
        { ...canceled, creationState: 'active' },
        acquiring,
      ),
    ).toBe(acquiring);
    // Start and Stop observations must not erase a genuinely failed request.
    for (const [desired, power] of [
      ['start', 'running'],
      ['stop', 'stopped'],
    ] as const) {
      const retained: ManagedMachineV1 = {
        ...machine,
        desired,
        observation: { availability: 'present', power, observedAt: 30 },
      };
      const powerFailure = {
        ...failed,
        snapshot: {
          ...failed.snapshot,
          actionId: 'machines.managed.power.set' as const,
        },
      };
      expect(currentManagedCreationOperation(retained, powerFailure)).toBe(
        powerFailure,
      );
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
        actionId: 'machines.setup.apply' as const,
        scope: { ...operation.snapshot.scope, machineId: 'guest' },
        domainRef: {
          kind: 'machineSetup' as const,
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
          error:
            'The managing computer could not confirm the completed installation.',
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
      currentManagedCreationOperation(
        enrolled,
        {
          ...operation,
          snapshot: {
            ...operation.snapshot,
            actionId: 'machines.managed.bootstrap.retry',
          },
        },
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
            error: {
              errorCode: 'credential_unavailable',
              error: 'Credential unavailable',
            },
          },
        },
        connected,
      ),
    ).not.toBeNull();
  });
  it('recovers a retained unenrolled resource after controller operation history is lost', () => {
    const retained: ManagedMachineV1 = {
      ...machine,
      preset: { id: 'admitted-preset', revision: 1 },
      observation: { availability: 'present', power: 'running', observedAt: 1 },
      machineSetup: {
        setup: { scripts: [{ body: 'echo setup' }] },
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
  it('recovers incomplete enrollment on the same resource without mistaking a running installer or credential refusal for retryable work', () => {
    const incomplete: ManagedMachineV1 = { ...machine, enrolledMachineId: 'guest', bootstrapInstalled: true,
      observation: { availability: 'unavailable', reason: 'bootstrap.incomplete', observedAt: 4 } };
    const running: ActionOperationProjection = { serverId: machine.homeId, observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'retry', revision: 1, actionId: 'machines.managed.bootstrap.retry', state: 'running',
        scope: { accountId: 'owner', machineId: machine.controller.machineId }, title: 'Retry install', createdAt: 5,
        cancellation: 'supported', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller } } };
    expect(canRetryManagedInstallation(incomplete)).toBe(true);
    expect(canRetryManagedInstallation(incomplete, running)).toBe(false);
    const failedConfirmation: ActionOperationProjection = { ...running, snapshot: { ...running.snapshot,
      actionId: 'machines.managed.acquire', state: 'failed', settledAt: 6,
      error: { errorCode: 'managed_controller_request_failed', error: 'managed_controller_request_failed',
        details: { kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/current', category: 'status', status: 503 } } } };
    expect(canRetryManagedInstallation(incomplete, failedConfirmation, { enrolledMachine: {
      machineId: 'guest', installationId: 'guest-installation', online: true, serviceManaged: true } })).toBe(true);
    expect(canRetryManagedInstallation(incomplete, { ...running, snapshot: { ...running.snapshot, state: 'failed', settledAt: 6,
      error: { errorCode: 'credential_unavailable', error: 'Credential no longer available' } } })).toBe(false);
    expect(canRetryManagedInstallation({ ...incomplete, observation: { availability: 'unavailable', observedAt: 4 } })).toBe(false);
    expect(canRetryManagedInstallation({ ...incomplete, desired: 'delete' })).toBe(false);
    expect(canRetryManagedInstallation(incomplete, null, { providerAvailable: false })).toBe(false);
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
      setup: { scripts: [{ body: 'echo setup' }] },
      state: 'failed' as const,
      operation: { operationId: 'setup-operation' },
      errorCode: 'setup_failed',
    };
    expect(
      managedCreationSetup({
        ...machine,
        machineSetup: { ...setup, state: 'pending', errorCode: undefined },
      }),
    ).toBeNull();
    expect(
      managedCreationSetup({
        ...machine,
        enrolledMachineId: 'guest',
        machineSetup: setup,
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
        machineSetup: { ...setup, state: 'skipped', errorCode: undefined },
      }),
    ).toMatchObject({ state: 'skipped', recoveryActions: [] });
    expect(
      managedCreationSetup({
        ...machine,
        enrolledMachineId: 'guest',
        allocation: 'confirmed-absent',
        machineSetup: setup,
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
  it('opens an enrolled detail only after its canonical Machine exists', () => {
    expect(managedMachineEnrolledDetailId(machine, true)).toBeUndefined();
    const enrolled = { ...machine, enrolledMachineId: 'joined machine' };
    expect(managedMachineEnrolledDetailId(enrolled, false)).toBeUndefined();
    expect(managedMachineEnrolledDetailId(enrolled, true)).toBe('joined machine');
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
  it('keeps observed parking until a native Start is submitted instead of deriving Starting from retained desire', () => {
    // Desired Start can remain after an earlier completed start, so it does not prove a current transition.
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
    expect(managedCreationState(retained, { provider: 'Lima' }).kind).toBe('stoppedStorage');
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

describe('managed creation stages', () => {
  it('maps the recorded row to Create, Install and Join, current only while this device runs the recipe (58B-U1 facts)', () => {
    const stages = (row: ManagedMachineV1 | undefined, running: boolean) =>
      managedCreationStages(row, running).map(stage => [stage.id, stage.state, stage.note ?? null]);
    const account = { ...machine, controller: undefined };
    // Before the row exists the recipe's first step is running here; nothing else is claimed.
    expect(stages(undefined, true)).toEqual([['create', 'running', null], ['install', 'upcoming', null], ['join', 'upcoming', null]]);
    expect(stages({ ...account, allocation: 'may-exist', resource: undefined }, false))
      .toEqual([['create', 'upcoming', null], ['install', 'upcoming', null], ['join', 'upcoming', null]]);
    // Bound: created; this device installs it now.
    expect(stages(account, true)).toEqual([['create', 'done', null], ['install', 'running', null], ['join', 'upcoming', null]]);
    // Installed: joining now.
    expect(stages({ ...account, bootstrapInstalled: true }, true))
      .toEqual([['create', 'done', null], ['install', 'done', null], ['join', 'running', null]]);
    expect(stages({ ...account, bootstrapInstalled: true, enrolledMachineId: 'guest' }, false))
      .toEqual([['create', 'done', null], ['install', 'done', null], ['join', 'done', null]]);
    // Nothing runs it any more: a missing install fact is unknown, never guessed done; an installed one has not joined.
    expect(stages(account, false)).toEqual([['create', 'done', null], ['install', 'upcoming', 'notConfirmed'], ['join', 'upcoming', null]]);
    expect(stages({ ...account, bootstrapInstalled: true }, false))
      .toEqual([['create', 'done', null], ['install', 'done', null], ['join', 'upcoming', 'notJoined']]);
  });
});
