import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
// Popover positioning is a window/DOM boundary; render popover content inline.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
afterEach(() => standardCleanup());

const { buildRequesterDisclosureStatusBadge } = await import('./managedComposerBadges');

const stages = [
  { id: 'create', label: 'Create VM', state: 'done' as const },
  { id: 'install', label: 'Install Happier', state: 'running' as const },
  { id: 'join', label: 'Join Personal Home', state: 'upcoming' as const },
];

describe('managed composer badges', () => {
  it.each(['home_not_guest_reachable', 'action_failed', 'native_install_failed'] as const)(
    'presents a failed creation through the shared failure owner (%s)', async errorCode => {
      const { buildNewSessionManagedProgressBadge } = await import('@/components/sessions/new/hooks/screenModel/newSessionManagedProgressBadge');
      const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
      const { t } = await import('@/text');
      const selection = createManagedMachineSelectionDraft({
        selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
        receipt: { launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
          controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
          billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['stop', 'delete'] },
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
      });
      const raw = errorCode === 'native_install_failed' ? 'installer diagnostic with commands' : 'home_not_guest_reachable';
      const badge = buildNewSessionManagedProgressBadge({ selection, acquisition: null, select: () => {}, retryInstallation: () => {},
        progress: { kind: 'failed', code: errorCode, operation: {
          version: 1, operationId: 'creation', revision: 1, actionId: 'machines.managed.acquire', state: 'failed',
          scope: { accountId: 'owner', machineId: 'controller' }, title: 'Create Guest', createdAt: 1, cancellation: 'unsupported',
          error: { errorCode, error: raw },
        } } });
      const screen = await renderScreen(<>{badge?.renderPopover?.({ open: true,
        anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
      expect(screen.getTextContent()).toContain(t(errorCode === 'native_install_failed'
        ? 'newSession.failedToStart' : 'managedMachines.creation.homeNotGuestReachable'));
      expect(screen.getTextContent()).not.toContain(raw);
    },
  );

  it('keeps automatic archive effects unavailable without the controller admission projection', async () => {
    const { buildNewSessionManagedProgressBadge } = await import('@/components/sessions/new/hooks/screenModel/newSessionManagedProgressBadge');
    const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
    const selection = createManagedMachineSelectionDraft({
      selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      receipt: { launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['stop', 'delete'] },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    const badge = buildNewSessionManagedProgressBadge({ selection, acquisition: null, select: () => {},
      progress: { kind: 'acquiring' }, retryInstallation: () => {}, updateArchiveEffect: vi.fn() });
    const screen = await renderScreen(<>{badge?.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    const archive = screen.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-archive')[0];
    expect(archive?.props.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stop', disabled: true }),
      expect.objectContaining({ id: 'delete', disabled: true }),
    ]));
  });

  it('words a task-born machine\'s archive rule by the task finishing, in the visible label and for assistive technology', async () => {
    const { buildNewSessionManagedProgressBadge } = await import('@/components/sessions/new/hooks/screenModel/newSessionManagedProgressBadge');
    const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
    const { t } = await import('@/text');
    const selection = createManagedMachineSelectionDraft({
      selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      receipt: { launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['stop', 'delete'] },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    const draft = { selection, acquisition: null, select: () => {}, progress: { kind: 'acquiring' as const },
      retryInstallation: () => {}, updateArchiveEffect: vi.fn() };
    const open = async (creationScope?: 'session' | 'task') => {
      const badge = buildNewSessionManagedProgressBadge({ ...draft, ...(creationScope ? { creationScope } : {}) });
      return renderScreen(<>{badge?.renderPopover?.({ open: true,
        anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    };
    const task = await open('task');
    const taskGroup = task.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-archive')[0];
    expect(taskGroup?.props.accessibilityLabel).toBe(t('managedRetention.whenTaskFinishes'));
    expect(task.findAll(node => node.props?.children === t('managedRetention.whenTaskFinishes')).length).toBeGreaterThan(0);
    expect(task.findAll(node => node.props?.children === t('managedRetention.whenSessionArchived'))).toHaveLength(0);
    await task.unmount();
    // A Session-born machine keeps the Session wording.
    const session = await open();
    expect(session.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-archive')[0]?.props.accessibilityLabel)
      .toBe(t('managedRetention.whenSessionArchived'));
  });

  it('keeps unsupported archive effects explicit and unavailable', async () => {
    const { buildManagedProgressStatusBadge } = await import('./managedComposerBadges');
    const badge = buildManagedProgressStatusBadge({
      machineName: 'Guest', mark: null, launch: '', stages: [], failed: false,
      label: 'Waiting', message: 'Waiting',
      archiveChoice: { value: 'keep', onChange: vi.fn(), supportedEffects: ['keep', 'delete'],
        availability: { controllerMachineId: 'controller', supportedEffects: ['keep', 'delete'], nativeUnsupportedEffects: ['stop'] } },
    });
    const screen = await renderScreen(<>{badge.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    const archive = screen.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-archive')[0];
    expect(archive?.props.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'keep' }),
      // A disabled effect says why, so the bar never offers a silent dead segment.
      expect.objectContaining({ id: 'stop', disabled: true, unavailableReason: expect.any(String) }),
      expect.objectContaining({ id: 'delete', disabled: false, unavailableReason: undefined }),
    ]));
  });

  it('preserves an observed creation failure that is not an installation failure', async () => {
    const { buildManagedProgressStatusBadge } = await import('./managedComposerBadges');
    const badge = buildManagedProgressStatusBadge({
      machineName: 'Guest', mark: null, launch: '', stages: [], failed: true,
      label: 'Failed', failureLabel: 'Failed', failureTitle: 'Failed',
      message: 'Native creation was refused',
    });
    expect(badge.label).toBe('Failed');
    const screen = await renderScreen(<>{badge.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    expect(screen.getTextContent()).toContain('Native creation was refused');
    expect(screen.getTextContent()).not.toContain('couldn’t install');
  });

  it('labels the badge with the latest observed stage and turns warning only on an observed failure', async () => {
    const { buildManagedProgressStatusBadge } =
      await import('./managedComposerBadges');
    const running = buildManagedProgressStatusBadge({
      machineName: 'mac-vm-2',
      mark: null,
      launch: 'Mac desktop · macOS Tahoe',
      stages,
      failed: false,
      label: 'Installing Happier on mac-vm-2',
      message: 'Your message waits here until mac-vm-2 joins.',
    });
    expect(running.label).toBe('Installing Happier on mac-vm-2');
    // Creation in progress needs nothing from the user: the quiet badge (lab `m-pick-Aprog`).
    expect(running.tone).toBe('neutral');
    const failed = buildManagedProgressStatusBadge({
      machineName: 'mac-vm-2',
      mark: null,
      launch: 'Mac desktop',
      stages: stages.map((stage) =>
        stage.id === 'install'
          ? { ...stage, state: 'failed' as const }
          : stage,
      ),
      failed: true,
      label: 'Installing Happier on mac-vm-2',
      message: 'Retrying uses this same machine.',
    });
    expect(failed.label).toBe('Install failed');
    expect(failed.tone).toBe('warning');
  });

  it('offers the archive choice at creation and retry/delete only after a failure', async () => {
    const { buildManagedProgressStatusBadge } =
      await import('./managedComposerBadges');
    const choices: string[] = [];
    const onRetryInstall = vi.fn();
    const badge = buildManagedProgressStatusBadge({
      machineName: 'mac-vm-2',
      mark: null,
      launch: 'Mac desktop',
      stages,
      failed: false,
      label: 'Installing Happier on mac-vm-2',
      message: 'waits',
      archiveChoice: { value: 'keep', onChange: (next) => choices.push(next) },
      onCancel: vi.fn(),
      onRetryInstall,
    });
    const anchorRef = React.createRef<unknown>();
    const screen = await renderScreen(
      <>
        {badge.renderPopover?.({
          open: true,
          anchorRef,
          onRequestClose: () => undefined,
        })}
      </>,
    );
    expect(
      screen.findByTestId('managed-machine-progress-cancel'),
    ).not.toBeNull();
    // Retry belongs to the failed state only.
    expect(screen.findByTestId('managed-machine-progress-retry')).toBeNull();
    const archive = screen.findAll(
      (node) => node.props?.testIDPrefix === 'managed-machine-progress-archive',
    )[0];
    expect(archive?.props.activeTabId).toBe('keep');
    await act(async () => {
      archive!.props.onSelectTab('stop');
    });
    expect(choices).toEqual(['stop']);
  });

  it('after a failed Set up offers Retry setup, Continue without setup and Delete, and no archive choice (D53)', async () => {
    const { buildManagedProgressStatusBadge } =
      await import('./managedComposerBadges');
    const onRetrySetup = vi.fn();
    const onContinueWithoutSetup = vi.fn();
    const badge = buildManagedProgressStatusBadge({
      machineName: 'mac-vm-2',
      mark: null,
      launch: 'Mac desktop',
      stages: [
        ...stages.map((stage) => ({ ...stage, state: 'done' as const })),
        { id: 'setup', label: 'Set up', state: 'failed' as const },
      ],
      failed: true,
      label: 'Set up · Failed',
      message: 'Your message waits here.',
      archiveChoice: { value: 'keep', onChange: () => undefined },
      onRetrySetup,
      onContinueWithoutSetup,
      onDeleteMachine: vi.fn(),
    });
    const screen = await renderScreen(
      <>
        {badge.renderPopover?.({
          open: true,
          anchorRef: React.createRef<unknown>(),
          onRequestClose: () => undefined,
        })}
      </>,
    );
    expect(screen.findByTestId('managed-machine-progress-delete')).not.toBeNull();
    expect(screen.findByTestId('managed-machine-progress-retry')).toBeNull();
    expect(
      screen.findAll((node) => node.props?.testIDPrefix === 'managed-machine-progress-archive'),
    ).toHaveLength(0);
    await act(async () => {
      for (const testID of ['managed-machine-progress-retry-setup', 'managed-machine-progress-skip-setup']) {
        screen.findAll((node) => node.props?.testID === testID && typeof node.props.onPress === 'function')[0]!.props.onPress();
      }
    });
    expect(onRetrySetup).toHaveBeenCalledTimes(1);
    expect(onContinueWithoutSetup).toHaveBeenCalledTimes(1);
    // The irreversible delete reads as destructive, and only one next step is bordered.
    const buttons = screen.findAll((node) => typeof node.props?.testID === 'string'
      && node.props.testID.startsWith('managed-machine-progress-') && typeof node.props.display === 'string');
    const display = (testID: string) => buttons.find((node) => node.props.testID === testID)?.props.display;
    expect(display('managed-machine-progress-delete')).toBe('destructive');
    expect(new Set(buttons.filter((node) => node.props.display === 'secondary').map((node) => node.props.testID)).size).toBe(1);
  });

  it('says whose machine a requester session runs on and how the sign-in lands', async () => {
    const badge = buildRequesterDisclosureStatusBadge({
      owner: 'Ben',
      machine: 'build-01',
      signIn: 'scoped',
    });
    expect(badge.label).toBe('Runs on Ben’s build-01');
  });

  it('shows actual full sign-in and machine-user visibility, never scoped access, for the ordinary requester route', async () => {
    const badge = buildRequesterDisclosureStatusBadge({ owner: 'Alice', machine: 'devbox', signIn: 'full' });
    const screen = await renderScreen(<>{badge.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    const text = screen.getTextContent();
    expect(text).toContain('Your Happier sign-in is stored on devbox');
    expect(text).toContain('Alice and anyone who can sign in to devbox');
    expect(text).not.toContain('works only for this session');
  });

  it.each(['scoped', 'full'] as const)('names selected sign-in purposes without revealing their account references (%s)', async signIn => {
    const badge = buildRequesterDisclosureStatusBadge({ owner: 'Alice', machine: 'devbox', signIn,
      signInPurposes: ['OpenAI', 'Anthropic (native sign-in)'] });
    const screen = await renderScreen(<>{badge.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    expect(screen.getTextContent()).toContain('OpenAI');
    expect(screen.getTextContent()).toContain('Anthropic (native sign-in)');
    expect(screen.getTextContent()).not.toContain('Linear');
  });

  describe('creation from this device (58d U5)', () => {
    const accountReceipt = {
      launch: { provider: { pluginId: 'machine.vercel', localId: 'sandbox' }, schemaVersion: 1, name: 'vercel-1', choices: {} },
      optionStatus: 'current' as const, prerequisites: [],
      billing: { location: 'cloud' as const, stoppedBilling: 'not-billed' as const },
      retentionCapabilities: { supportedIntents: ['stop' as const, 'delete' as const] },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    };
    const selectionFor = async (controller?: { machineId: string; installationId: string }) => {
      const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
      return createManagedMachineSelectionDraft({ selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
        receipt: { ...accountReceipt, ...(controller ? { controller } : {}) } });
    };
    const openPopover = async (badge: { renderPopover?: (ctx: { open: boolean; anchorRef: React.RefObject<unknown>; onRequestClose: () => void }) => React.ReactNode } | null) =>
      renderScreen(<>{badge?.renderPopover?.({ open: true, anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);

    it('names this device and asks to keep the app open only while this device does the work', async () => {
      const { buildNewSessionManagedProgressBadge } = await import('@/components/sessions/new/hooks/screenModel/newSessionManagedProgressBadge');
      const { t } = await import('@/text');
      const { readMachineAddDevice } = await import('@/components/machines/add/useMachineAddPaths');
      const device = readMachineAddDevice();
      const origin = device === 'phone' ? t('managedMachines.creation.fromThis.phone')
        : device === 'browser' ? t('managedMachines.creation.fromThis.browser') : t('managedMachines.creation.fromThis.desktop');
      const base = { acquisition: null, select: () => {}, retryInstallation: () => {} };
      // No controller: this app creates and installs it, so it says so and asks to stay open. It is creating, not waiting.
      const hereBadge = buildNewSessionManagedProgressBadge({ ...base, selection: await selectionFor(), progress: { kind: 'acquiring' } });
      expect(hereBadge?.label).toBe(t('managedMachines.creation.creating', { name: 'vercel-1' }));
      const here = await openPopover(hereBadge);
      expect(here.getTextContent()).toContain(origin);
      expect(here.findByTestId('managed-machine-progress-hold')).toBeTruthy();
      await here.unmount();
      // A controller does the work: neither line.
      const controller = await openPopover(buildNewSessionManagedProgressBadge({ ...base,
        selection: await selectionFor({ machineId: 'controller', installationId: 'installation' }), progress: { kind: 'acquiring' } }));
      expect(controller.getTextContent()).not.toContain(origin);
      expect(controller.findByTestId('managed-machine-progress-hold')).toBeNull();
      await controller.unmount();
      await (async () => {
        // The row says the sandbox is bound and installed while this device still runs the recipe: Join is current.
        const row: ManagedMachineV1 = { id: 'managed-1', homeId: 'home', custodianAccountId: 'account', launch: accountReceipt.launch,
          allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, bootstrapInstalled: true,
          resource: { contributionRef: { pluginId: 'machine.vercel', localId: 'sandbox' }, schemaVersion: 1, value: { id: 'sbx_1' } } };
        const badge = buildNewSessionManagedProgressBadge({ ...base, selection: await selectionFor(),
          progress: { kind: 'acquiring', managedId: 'managed-1' }, retainedMachine: { machine: row, inspect: () => {} } });
        expect(badge?.label).toBe(t('managedMachines.creation.joining', { name: 'vercel-1' }));
        const staged = await openPopover(badge);
        expect(staged.findByTestId('managed-machine-progress-step-done-install')).toBeTruthy();
        expect(staged.findByTestId('managed-machine-progress-step-running-join')).toBeTruthy();
        await staged.unmount();
      })();
      // The guest joins on its own once the resource is ready: nothing holds this device any more.
      const joining = await openPopover(buildNewSessionManagedProgressBadge({ ...base, selection: await selectionFor(),
        progress: { kind: 'enrollment_pending', managedId: 'managed-1' } }));
      expect(joining.findByTestId('managed-machine-progress-hold')).toBeNull();
    });

    it('reads a retained, bound, unjoined machine as Setup interrupted with the same-resource ways forward', async () => {
      const { buildNewSessionManagedProgressBadge } = await import('@/components/sessions/new/hooks/screenModel/newSessionManagedProgressBadge');
      const { t } = await import('@/text');
      const machine: ManagedMachineV1 = {
        id: 'managed-1', homeId: 'home', custodianAccountId: 'account', launch: accountReceipt.launch,
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        resource: { contributionRef: { pluginId: 'machine.vercel', localId: 'sandbox' }, schemaVersion: 1, value: { id: 'sbx_1' } },
      };
      const retryInstallation = vi.fn();
      const inspect = vi.fn();
      const draft = { acquisition: null, select: () => {}, retryInstallation, selection: await selectionFor(),
        progress: { kind: 'idle' as const }, cancel: vi.fn(), updateArchiveEffect: vi.fn() };
      const badge = buildNewSessionManagedProgressBadge({ ...draft, retainedMachine: { machine, inspect } });
      expect(badge?.label).toBe(t('managedMachines.creation.interruptedTitle'));
      expect(badge?.tone).toBe('warning');
      const screen = await openPopover(badge);
      // Nothing is running: no Cancel, no creation-time archive choice, no spinner stage.
      expect(screen.findByTestId('managed-machine-progress-cancel')).toBeNull();
      expect(screen.findAll(node => node.props?.testIDPrefix === 'managed-machine-progress-archive')).toHaveLength(0);
      expect(screen.findByTestId('managed-machine-progress-step-running-install')).toBeNull();
      // No install fact on the row: unknown, said as such, not drawn done.
      expect(screen.findByTestId('managed-machine-progress-step-done-install')).toBeNull();
      expect(screen.getTextContent()).toContain(t('managedMachines.creation.notConfirmed'));
      act(() => { screen.findByTestId('managed-machine-progress-continue')?.props.onPress?.(); });
      act(() => { screen.findByTestId('managed-machine-progress-inspect')?.props.onPress?.(); });
      expect(retryInstallation).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledTimes(1);
      await screen.unmount();
      // Joined, or never bound: not interrupted, so there is nothing to say here.
      expect(buildNewSessionManagedProgressBadge({ ...draft,
        retainedMachine: { machine: { ...machine, enrolledMachineId: 'guest-1' }, inspect } })).toBeNull();
      expect(buildNewSessionManagedProgressBadge({ ...draft,
        retainedMachine: { machine: { ...machine, allocation: 'may-exist', resource: undefined }, inspect } })).toBeNull();
    });
  });
});
