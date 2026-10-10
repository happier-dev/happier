import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const stages = [
  { id: 'create', label: 'Create VM', status: 'done' as const },
  { id: 'install', label: 'Install Happier', status: 'active' as const },
  { id: 'join', label: 'Join Personal Home', status: 'pending' as const },
];

describe('managed composer badges', () => {
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

  it('keeps unsupported archive effects explicit and unavailable', async () => {
    const { buildManagedProgressStatusBadge } = await import('./managedComposerBadges');
    const badge = buildManagedProgressStatusBadge({
      machineName: 'Guest', mark: null, recipe: '', stages: [], failed: false,
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
      machineName: 'Guest', mark: null, recipe: '', stages: [], failed: true,
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
      recipe: 'Mac desktop · macOS Tahoe',
      stages,
      failed: false,
      label: 'Installing Happier on mac-vm-2',
      message: 'Your message waits here until mac-vm-2 joins.',
    });
    expect(running.label).toBe('Installing Happier on mac-vm-2');
    expect(running.tone).toBe('active');
    const failed = buildManagedProgressStatusBadge({
      machineName: 'mac-vm-2',
      mark: null,
      recipe: 'Mac desktop',
      stages: stages.map((stage) =>
        stage.id === 'install'
          ? { ...stage, status: 'failed' as const }
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
      recipe: 'Mac desktop',
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
      recipe: 'Mac desktop',
      stages: [
        ...stages.map((stage) => ({ ...stage, status: 'done' as const })),
        { id: 'setup', label: 'Set up', status: 'failed' as const },
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
    const { buildRequesterDisclosureStatusBadge } =
      await import('./managedComposerBadges');
    const badge = buildRequesterDisclosureStatusBadge({
      owner: 'Ben',
      machine: 'build-01',
      signIn: 'scoped',
    });
    expect(badge.label).toBe('Runs on Ben’s build-01');
  });

  it('shows actual full sign-in and machine-user visibility, never scoped access, for the ordinary requester route', async () => {
    const { buildRequesterDisclosureStatusBadge } = await import('./managedComposerBadges');
    const badge = buildRequesterDisclosureStatusBadge({ owner: 'Alice', machine: 'devbox', signIn: 'full' });
    const screen = await renderScreen(<>{badge.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    const text = screen.getTextContent();
    expect(text).toContain('Your Happier sign-in is stored on devbox');
    expect(text).toContain('Alice and anyone who can sign in to devbox');
    expect(text).not.toContain('works only for this session');
  });

  it.each(['scoped', 'full'] as const)('names selected sign-in purposes without revealing their account references (%s)', async signIn => {
    const { buildRequesterDisclosureStatusBadge } = await import('./managedComposerBadges');
    const badge = buildRequesterDisclosureStatusBadge({ owner: 'Alice', machine: 'devbox', signIn,
      signInPurposes: ['OpenAI', 'Anthropic (native sign-in)'] });
    const screen = await renderScreen(<>{badge.renderPopover?.({ open: true,
      anchorRef: React.createRef<unknown>(), onRequestClose: () => undefined })}</>);
    expect(screen.getTextContent()).toContain('OpenAI');
    expect(screen.getTextContent()).toContain('Anthropic (native sign-in)');
    expect(screen.getTextContent()).not.toContain('Linear');
  });
});
