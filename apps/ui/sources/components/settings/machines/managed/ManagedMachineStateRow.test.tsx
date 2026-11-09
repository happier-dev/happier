import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routerBoundary = createExpoRouterMock();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  router: async () => routerBoundary.module,
  storage: 'real',
});
afterEach(() => standardCleanup());

const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
// Pages render under the app shell, which owns the Account's one Investigate owner (D5).
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const renderScreen: typeof renderTestScreen = (element, options = {}) => renderTestScreen(element, { ...options, wrapper: AccountNoticeInvestigationBoundary });

describe('managed lifecycle presentation', () => {
  it.each(['newer-unknown', 'no-observation', 'older-observation', 'same-time-observation', 'confirmed-absent', 'absent-without-operation', 'newer-clear'] as const)(
    'shows current acquisition Details for %s', async scenario => {
      const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
      const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
      const { t } = await import('@/text');
      const absent = scenario === 'confirmed-absent' || scenario === 'absent-without-operation';
      const currentObservation = scenario === 'newer-unknown' || absent;
      const reason = absent ? 'native_acquisition_absent' : 'native_acquisition_unconfirmed';
      const machine = ManagedMachineV1Schema.parse({ id: 'acquisition-details', homeId: 'home', custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' },
        allocation: absent ? 'confirmed-absent' : 'may-exist', creationState: 'active',
        // An ended machine retains the resource it once bound; ce0e3072ad distinguishes a never-created request.
        resource: absent ? { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' },
          schemaVersion: 1, value: { instance: 'acquisition-details' } } : undefined,
        desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: scenario === 'no-observation' ? undefined : {
          observedAt: scenario === 'older-observation' ? 15 : scenario === 'same-time-observation' ? 20 : 30,
          availability: absent ? 'absent' : scenario === 'newer-clear' ? 'present' : 'unavailable',
          reason: scenario === 'newer-clear' ? undefined : reason,
          nativeCause: scenario === 'newer-clear' ? undefined : { localCause: 'native_command_failed', command: 'restart',
            exitCode: 1, stderr: 'native start still unconfirmed' },
        } });
      const operation = scenario === 'absent-without-operation' ? undefined : {
        serverId: machine.homeId, observation: 'available' as const, isUnavailableProjection: false,
        snapshot: ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'creation-operation', revision: 1,
          actionId: 'machines.managed.acquire', state: 'failed', scope: { accountId: 'owner', machineId: 'controller' },
          title: 'Create', createdAt: 10, startedAt: 11, settledAt: 20, cancellation: 'supported',
          domainRef: { kind: 'managedMachine', id: machine.id },
          error: { errorCode: 'old_creation_failure', error: 'previous creation failed',
            details: { kind: 'managedNative', nativeCause: { localCause: 'native_command_failed', command: 'create',
              exitCode: 2, stderr: 'old creation output' } } } }),
      };
      const screen = await renderScreen(<ManagedCreationProgress machine={machine} operation={operation} />);
      if (absent) expect(screen.getTextContent()).toContain(t('managedPower.resourceAbsent'));
      if (scenario === 'newer-clear') {
        expect(screen.findByTestId('managed-machine.installation-error')).toBeNull();
        return;
      }
      // Failed operations use the shared AttentionBanner; newer native observations use SurfaceStateCard.
      await screen.pressByTestIdAsync(currentObservation ? 'managed-machine.installation-error-details-toggle'
        : 'managed-machine.installation-error.details');
      const text = screen.getTextContent();
      if (currentObservation) {
        expect(text).toContain(reason);
        expect(text).toContain('restart · exit 1 · native start still unconfirmed');
        expect(text).not.toContain('old_creation_failure');
        expect(text).not.toContain('old creation output');
      } else {
        expect(text).toContain('old_creation_failure');
        expect(text).toContain('create · exit 2 · old creation output');
        expect(text).not.toContain('native start still unconfirmed');
      }
    },
  );

  it('keeps confirmed-absent recovery enabled inside a noninteractive historical resource row', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const machine = ManagedMachineV1Schema.parse({ id: 'ended-resource', homeId: 'home', custodianAccountId: 'owner',
      launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Ended resource', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'confirmed-absent', creationState: 'active',
      desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const remove = vi.fn();
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{ remove }} />);
    const action = screen.tree.findAll(node => typeof node.type === 'string'
      && node.props.testID === 'managed-machine.progress:remove');
    expect(action).toHaveLength(1);
    // aria-disabled on any emitted ancestor disables the descendant too, even when the button itself is enabled.
    for (let node: ReactTestInstance | null = action[0] ?? null; node; node = node.parent) {
      if (typeof node.type !== 'string') continue;
      expect(node.props['aria-disabled']).not.toBe(true);
      expect(node.props.accessibilityState?.disabled).not.toBe(true);
    }
    const row = screen.tree.findAll(node => typeof node.type === 'string'
      && node.props.testID === 'managed-machine.progress');
    expect(row).toHaveLength(1);
    expect(row[0]!.props.onPress).toBeUndefined();
    expect(row[0]!.props.role).not.toBe('button');
    expect(remove).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('managed-machine.progress:remove');
    expect(remove).toHaveBeenCalledOnce();
  });
  it('reads a native resource identity as one fact per line, never a JSON dump', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const provider = { pluginId: 'custom.provisioner', localId: 'native' };
    const machine = ManagedMachineV1Schema.parse({ id: 'bound-resource', homeId: 'home', custodianAccountId: 'owner',
      launch: { provider, schemaVersion: 1, name: 'Bound resource', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
      resource: { contributionRef: provider, schemaVersion: 1, value: { instance: 'happier-qb-design', cpus: 2, mounts: [] } },
      cleanup: { disposition: 'unavailable', reason: 'native_records_missing' },
      desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} />);
    const identity = screen.tree.findAll(node => typeof node.type === 'string' && node.props.testID === 'managed-machine.recovery');
    expect(identity).toHaveLength(1);
    const text = screen.getTextContent();
    expect(text).not.toContain('{"');
    expect(text).toContain('instance: happier-qb-design');
    expect(text).toContain('cpus: 2');
  });
  it('never words an accepted or unknown outcome as done', async () => {
    const { describeManagedLifecycleState } =
      await import('./managedLifecyclePresentation');
    const pending = describeManagedLifecycleState({ kind: 'stopPending' });
    expect(pending.tone).toBe('pending');
    expect(pending.line).toBe(
      'Stop requested. Stopping hasn’t been confirmed.',
    );
    const cleanup = describeManagedLifecycleState({
      kind: 'cleanupPending',
      reason: 'Hetzner returned 503.',
    });
    expect(cleanup.tone).toBe('danger');
    expect(cleanup.line).toContain('Provider charges may continue');
    expect(cleanup.line).not.toMatch(/\bdeleted\b/i);
    const missing = describeManagedLifecycleState({
      kind: 'localMissing',
      controller: 'MacBook Pro',
    });
    expect(missing.line).toContain('Confirm it’s gone');
    expect(missing.actions).toEqual(['checkNow']);
  });

  it.each(['cleanupPending', 'cleanupUnknown', 'creationCanceledCleanup'] as const)('offers console recovery only when its owner supplies a handler (%s)', async kind => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow
        testID="row"
        name="hz-build-0"
        mark={null}
        provider="Hetzner"
        state={{ kind }}
        handlers={{}}
      />,
    );
    expect(screen.findByTestId('row:openProvider')).toBeNull();
    await screen.update(<ManagedMachineStateRow testID="row" name="hz-build-0" mark={null}
      provider="Hetzner" state={{ kind }} handlers={{ openProvider: () => pressed.push('openProvider') }} />);
    await act(async () => {
      screen.pressByTestId('row:openProvider');
    });
    expect(pressed).toEqual(['openProvider']);
  });

  it('speaks a deletion that was not confirmed as the page banner, with Try again before the way out', async () => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const { t } = await import('@/text');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow testID="row" name="hz-build-0" mark={null} provider="Hetzner"
        state={{ kind: 'cleanupPending', reason: 'Hetzner returned 503.' }}
        handlers={{ openProvider: () => pressed.push('openProvider'), tryAgain: () => pressed.push('tryAgain') }} />,
    );
    // A banner, titled with the state rather than the resource's name.
    expect(screen.findByTestId('row')).not.toBeNull();
    expect(screen.tree.findAll((node) => node.props.children === t('managedCleanup.pendingTitle')).length).toBeGreaterThan(0);
    expect(screen.tree.findAll((node) => node.props.children === 'hz-build-0')).toHaveLength(0);
    await act(async () => { screen.pressByTestId('row:tryAgain'); });
    await act(async () => { screen.pressByTestId('row:openProvider'); });
    expect(pressed).toEqual(['tryAgain', 'openProvider']);
  });

  it('waits for an offline controller in a banner that can cancel the creation', async () => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const { t } = await import('@/text');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow testID="row" name="hz-build-3" mark={null} provider="Hetzner"
        state={{ kind: 'controllerWaiting', name: 'hz-build-3', controller: 'MacBook Pro', provider: 'Hetzner' }}
        handlers={{ cancel: () => pressed.push('cancel') }} />,
    );
    expect(screen.tree.findAll((node) => node.props.children === t('managedMachines.controller.waiting', { controller: 'MacBook Pro' })).length)
      .toBeGreaterThan(0);
    await act(async () => { screen.pressByTestId('row:cancel'); });
    expect(pressed).toEqual(['cancel']);
  });

  it('tints only the cause of a per-resource fact, never the next step', async () => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedMachineStateRow testID="row" name="mac-vm-0" mark={null}
        state={{ kind: 'localMissing', controller: 'MacBook Pro' }} handlers={{}} />,
    );
    const cause = t('managedMachines.local.missingCause', { controller: 'MacBook Pro' });
    const causeNodes = screen.tree.findAll((node) => node.props.children === cause);
    expect(causeNodes.length).toBeGreaterThan(0);
    // The whole sentence pair is never one tinted string.
    expect(screen.tree.findAll((node) => node.props.children === `${cause} ${t('managedMachines.local.missingDetail')}`)).toHaveLength(0);
  });

  it('opens the Account default that turned creating machines off', async () => {
    const { ManagedCreationDisabledBanner } = await import('./ManagedMachineStateRow');
    routerBoundary.spies.push.mockClear();
    const screen = await renderScreen(<ManagedCreationDisabledBanner testID="off" />);
    await act(async () => { screen.pressByTestId('off:change'); });
    expect(routerBoundary.spies.push).toHaveBeenCalledWith('/settings/machines/defaults');
  });
});

describe('created machine resource rows (UIR5)', () => {
  const provider = { pluginId: 'custom.provisioner', localId: 'native' };
  async function boundMachine(overrides: Record<string, unknown> = {}) {
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    return ManagedMachineV1Schema.parse({ id: 'studio', homeId: 'home', custodianAccountId: 'owner',
      launch: { provider, schemaVersion: 1, name: 'Lima', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest', allocation: 'bound', creationState: 'active',
      resource: { contributionRef: provider, schemaVersion: 1, value: { instance: 'happier-studio', cpus: 2 } },
      observation: { observedAt: 5, availability: 'present', power: 'stopped', storage: 'unknown' },
      desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, ...overrides });
  }
  const testIds = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
    screen.tree.findAll(node => typeof node.type === 'string' && node.props.testID === id);

  it.each([
    ['running', 'bootstrap.incomplete'],
    ['failed', 'bootstrap.incomplete'],
    ['failed', 'bootstrap.native_command_failed'],
  ] as const)('presents %s bootstrap evidence (%s) through the operation lifecycle', async (state, reason) => {
    const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
    const machine = await boundMachine({ enrolledMachineId: undefined, desired: 'start', observation: {
      observedAt: 30, availability: 'unavailable', reason,
      ...(reason === 'bootstrap.native_command_failed' ? { nativeCause: {
        localCause: 'native_command_failed', command: 'run', exitCode: 1, stderr: 'guest installation failed',
      } } : {}),
    } });
    const operation = { serverId: machine.homeId, observation: 'available' as const, isUnavailableProjection: false,
      snapshot: ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'bootstrap', revision: 1,
        actionId: 'machines.managed.acquire', state, scope: { accountId: 'owner', machineId: 'controller' },
        title: 'Create', createdAt: 10, startedAt: 20, cancellation: 'supported',
        domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller },
        progress: { kind: 'phase', phase: 'managed.bootstrap.install', label: 'Installing Happier' },
        ...(state === 'failed' ? { settledAt: 40, error: { errorCode: 'action_failed', error: 'bootstrap failed' } } : {}),
      }) };
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} operation={operation} />);
    if (state === 'running') {
      expect(screen.findByTestId('managed-machine.installation-error')).toBeNull();
      expect(screen.findByTestId('managed-machine.installation')).not.toBeNull();
      expect(screen.getTextContent()).toContain('Installing Happier');
      expect(screen.findByTestId('managed-machine.progress')).toBeNull();
      return;
    }
    expect(screen.findByTestId('managed-machine.installation-error')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(reason);
    expect(screen.getTextContent()).not.toContain('guest installation failed');
    await screen.pressByTestIdAsync('managed-machine.installation-error-details-toggle');
    expect(screen.getTextContent()).toContain(reason);
    if (reason === 'bootstrap.native_command_failed') {
      expect(screen.getTextContent()).toContain('run · exit 1 · guest installation failed');
    }
    await screen.update(<ManagedCreationProgress machine={machine} operation={operation} handlers={{ checkNow: vi.fn() }} checking />);
    // The current observation owns Check now; its diagnostic does not repeat the action.
    expect(testIds(screen, 'managed-machine.progress:checkNow')).toHaveLength(1);
    expect(screen.findByTestId('managed-machine.installation-check')).toBeNull();
    expect(screen.findByTestId('managed-machine.progress:checkNow')?.props.accessibilityState?.busy).toBe(true);
  });

  it('keeps native identity out of a healthy created machine and names the row after the machine', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const machine = await boundMachine();
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} title="lima-happier-studio" handlers={{ checkNow: vi.fn() }} />);
    expect(testIds(screen, 'managed-machine.recovery')).toHaveLength(0);
    expect(screen.getTextContent()).not.toContain('instance: happier-studio');
    expect(screen.getTextContent()).toContain('lima-happier-studio');
  });

  it('reads freshness on the state row it qualifies and offers Check now once', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const machine = await boundMachine();
    const checkNow = vi.fn();
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{ checkNow }} />);
    expect(testIds(screen, 'managed-machine.observation')).toHaveLength(1);
    expect(testIds(screen, 'managed-machine.observation-check')).toHaveLength(0);
    expect(testIds(screen, 'managed-machine.progress:checkNow')).toHaveLength(1);
    expect(screen.findByTestId('managed-machine.progress:checkNow')?.props.accessibilityState?.busy).toBe(false);
    await screen.update(<ManagedCreationProgress machine={machine} handlers={{ checkNow }} checking />);
    expect(screen.findByTestId('managed-machine.progress:checkNow')?.props.accessibilityState?.busy).toBe(true);
    await screen.update(<ManagedCreationProgress machine={machine} handlers={{ checkNow }} checking={false} />);
    expect(screen.findByTestId('managed-machine.progress:checkNow')?.props.accessibilityState?.busy).toBe(false);
    // ACCEPT-1109 (2864e7dd3f): a healthy joined machine has no standalone freshness card.
    // Before enrollment the resource still needs Check now on its own state row.
    const healthy = await renderScreen(<ManagedCreationProgress machine={await boundMachine({ enrolledMachineId: undefined,
      observation: { observedAt: 5, availability: 'present', power: 'running', storage: 'retained' } })}
      handlers={{ checkNow }} />);
    expect(testIds(healthy, 'managed-machine.observation')).toHaveLength(1);
    expect(testIds(healthy, 'managed-machine.observation-check')).toHaveLength(0);
    expect(testIds(healthy, 'managed-machine.progress:checkNow')).toHaveLength(1);
    await healthy.pressByTestIdAsync('managed-machine.progress:checkNow');
    expect(checkNow).toHaveBeenCalledOnce();
  });

  it('adds no freshness card when a healthy joined machine has nothing to date or check', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const machine = await boundMachine({ desired: 'start',
      observation: { observedAt: 5, availability: 'present', power: 'running', storage: 'retained' } });
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{ checkNow: vi.fn() }} />);
    expect(testIds(screen, 'managed-machine.observation')).toHaveLength(0);
    expect(testIds(screen, 'managed-machine.progress')).toHaveLength(0);
  });

  it('offers Start on an asleep joined machine, on the row its freshness dates', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const start = vi.fn();
    const machine = await boundMachine({ observation: { observedAt: 5, availability: 'present', power: 'stopped', storage: 'retained' } });
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{ start }} />);
    expect(testIds(screen, 'managed-machine.progress:start')).toHaveLength(1);
    expect(testIds(screen, 'managed-machine.observation')).toHaveLength(1);
    await screen.update(<ManagedCreationProgress machine={machine} handlers={{ start }} starting />);
    expect(screen.findByTestId('managed-machine.progress:start')?.props.accessibilityState?.busy).toBe(true);
    await screen.update(<ManagedCreationProgress machine={machine} handlers={{ start }} starting={false} />);
    expect(screen.findByTestId('managed-machine.progress:start')?.props.accessibilityState?.busy).toBe(false);
    await screen.pressByTestIdAsync('managed-machine.progress:start');
    expect(start).toHaveBeenCalledTimes(1);
    const { t } = await import('@/text');
    expect(screen.getTextContent()).toContain(t('managedMachines.actions.start'));
    // No handler, nothing to offer: the header stays the only word for the state.
    const noStart = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{}} />);
    expect(testIds(noStart, 'managed-machine.progress')).toHaveLength(0);
  });

  it('keeps one freshness when the created-machine list could not be re-read: its time, the reason and Retry', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const retry = vi.fn();
    const screen = await renderScreen(<ManagedCreationProgress machine={await boundMachine()} handlers={{ checkNow: vi.fn() }}
      staleRead={{ retry }} />);
    expect(testIds(screen, 'managed-machine.observation')).toHaveLength(1);
    const { t } = await import('@/text');
    expect(screen.getTextContent()).toContain(t('managedMachines.detail.loadFailed'));
    const retryButtons = testIds(screen, 'managed-machine.observation-retry');
    expect(retryButtons).toHaveLength(1);
    expect(testIds(screen, 'managed-machine.observation-check')).toHaveLength(0);
  });

  it.each([
    ['Lume', 'happier.machine.lume', false],
    ['Lima', 'happier.machine.lima', false],
    ['Hetzner', 'happier.machine.hetzner', true],
  ] as const)('uses %s billing facts for an unconfirmed Delete and cleanup', async (name, pluginId, billed) => {
    const { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
    const declaration = Object.values(BUNDLED_MACHINE_PROVISIONER_DECLARATIONS)
      .find(entry => entry.contribution.pluginId === pluginId);
    if (!declaration) throw new Error(`Missing provisioner: ${pluginId}`);
    const { t } = await import('@/text');
    const machine = await boundMachine({
      enrolledMachineId: undefined,
      desired: 'delete',
      submittedNativeEffect: { intentRevision: 1, requestId: 'delete-request', intent: 'delete',
        controller: { machineId: 'controller', installationId: 'installation' } },
    });
    const facts = { ...machine, launch: { ...machine.launch, provider: declaration.contribution },
      reviewedFacts: { launch: { ...machine.launch, provider: declaration.contribution }, controller: machine.controller,
        optionStatus: 'current' as const, billing: declaration.descriptor.billing, prerequisites: [],
        retentionCapabilities: declaration.descriptor.retention, retention: machine.retention, wakeOnAcceptedMessage: false } };
    const screen = await renderScreen(<ManagedCreationProgress machine={facts} provider={name} />);
    expect(screen.getTextContent()).toContain(t('managedCleanup.pendingTitle'));
    expect(screen.getTextContent().includes(t('managedCleanup.pendingDetail'))).toBe(billed);
    await screen.update(<ManagedCreationProgress machine={{ ...facts,
      cleanup: { disposition: 'unavailable', reason: 'native_records_missing' } }} provider={name} />);
    expect(screen.getTextContent().includes(t('managedMachines.creation.mayBill'))).toBe(billed);
  });

  it('never says a local machine may bill', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const machine = await boundMachine({ enrolledMachineId: undefined, cleanup: { disposition: 'unavailable', reason: 'native_records_missing' } });
    const local = { ...machine, reviewedFacts: { launch: machine.launch, controller: machine.controller, optionStatus: 'current' as const,
      billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const }, prerequisites: [], retentionCapabilities: { supportedIntents: ['stop' as const] },
      retention: machine.retention, wakeOnAcceptedMessage: false } };
    const screen = await renderScreen(<ManagedCreationProgress machine={local} />);
    expect(screen.getTextContent()).not.toContain('may still be billed');
  });

  it('shows a held approval wait as needing the user, with its exact Ask one press away', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const machine = await boundMachine({ observation: { observedAt: 5, availability: 'present', power: 'running', storage: 'retained' } });
    const nativeController = machine.controller;
    if (!nativeController) throw new Error('The native fixture requires its installed controller.');
    const reviewApproval = vi.fn();
    const operation = { serverId: machine.homeId, observation: 'available' as const, isUnavailableProjection: false,
      snapshot: { version: 1 as const, operationId: 'policy-stop', revision: 3, actionId: 'machines.managed.power.set', state: 'running' as const,
        scope: { accountId: 'owner', machineId: nativeController.machineId }, title: 'Stop', createdAt: 1, startedAt: 2,
        domainRef: { kind: 'managedMachine' as const, id: machine.id, resource: machine.resource, controller: machine.controller },
        cancellation: 'supported' as const, progress: { kind: 'phase' as const, phase: 'waiting_for_approval', label: 'Waiting for approval',
          approval: { kind: 'approval_request_created' as const, artifactId: 'ask-1', actionId: 'machines.managed.power.set' } } } };
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} operation={operation as never} reviewApproval={reviewApproval} />);
    expect(screen.getTextContent()).toContain('Waiting for your approval');
    await act(async () => { screen.pressByTestId('managed-machine.installation-review'); });
    expect(reviewApproval).toHaveBeenCalledWith('ask-1');
  });

  it.each([
    ['managed.intent.busy', 'Waiting for guest work', 'managedRetention.busy'],
    ['managed.intent.draining', 'Finishing work', 'managedRetention.draining'],
  ] as const)('tells a Keep wait the operation reports (%s) once, as the machine\'s state with its freshness', async (phase, label, stateKey) => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const { t } = await import('@/text');
    const machine = await boundMachine({ observation: { observedAt: 5, availability: 'present', power: 'running', storage: 'retained' } });
    const operation = { serverId: machine.homeId, observation: 'available' as const, isUnavailableProjection: false,
      snapshot: { version: 1 as const, operationId: 'policy-stop', revision: 3, actionId: 'machines.managed.power.set', state: 'running' as const,
        scope: { accountId: 'owner', machineId: machine.controller.machineId }, title: 'Stop', createdAt: 1, startedAt: 2,
        domainRef: { kind: 'managedMachine' as const, id: machine.id, resource: machine.resource, controller: machine.controller },
        cancellation: 'supported' as const, progress: { kind: 'phase' as const, phase, label } } };
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} operation={operation as never} handlers={{ checkNow: vi.fn() }} />);
    // One card: the state row says the wait in the app's words; the producer's stage label is not a second copy of it.
    expect(testIds(screen, 'managed-machine.installation')).toHaveLength(0);
    expect(testIds(screen, 'managed-machine.progress')).toHaveLength(1);
    expect(screen.getTextContent()).toContain(t(stateKey));
    expect(screen.getTextContent()).not.toContain(label);
    expect(testIds(screen, 'managed-machine.observation')).toHaveLength(1);
  });
});
