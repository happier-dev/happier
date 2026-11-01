import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import type { TemporaryComputerLaunchController } from '../hooks/useTemporaryComputerLaunch';

const modalMock = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
}));
const platformMock = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ View: 'View', Pressable: 'Pressable' });
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return platformMock.os;
            },
        },
    };
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // The testkit default keeps interpolated parameters visible, which is the
    // only way an assertion can tell an exact date from a missing one.
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalMock.confirm } }).module;
});

function controller(
    status: TemporaryComputerLaunchController['status'],
    projectionState?: 'pending' | 'claimed' | 'consented' | 'closed' | 'materialized',
    closeReason?: 'canceled' | 'declined' | 'expired' | 'revoked' | 'failed',
    activationExpiresAt: number | null = null,
): TemporaryComputerLaunchController {
    return {
        status,
        projection: projectionState
            ? { state: projectionState, closeReason: closeReason ?? null, activationExpiresAt } as never
            : null,
        error: status.includes('failed') ? new Error('offline') : null,
        start: vi.fn(), retry: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), dismissTerminal: vi.fn(), replaceTerminal: vi.fn(),
    };
}

describe('TemporaryComputerLaunchSurface', () => {
    beforeEach(() => {
        platformMock.os = 'web';
        announceForAccessibilityMock.mockClear();
    });
    afterEach(() => {
        platformMock.os = 'web';
        vi.unstubAllGlobals();
    });
    it('states the exact localized expiry the Home actually froze for this package', async () => {
        const expiresAt = new Date(2031, 4, 17, 6, 42).getTime();
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer', 'pending', undefined, expiresAt)}
            // A stale local intent must not survive the activation that replaced it.
            pendingPackageExpiresAt={expiresAt - 60_000}
        />);

        const expiry = screen.findByTestId('temporary-computer-package-expiry');
        expect(expiry).not.toBeNull();
        expect(JSON.stringify(expiry?.props.children ?? expiry))
            .toContain(new Date(expiresAt).toLocaleString());
        await screen.unmount();
    });

    it('says a package with no expiry has none instead of staying silent about it', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer', 'pending')}
        />);

        expect(screen.findByTestId('temporary-computer-package-expiry')?.props.children)
            .toBe('newSession.temporaryComputer.expiry.noExpiry');
        await screen.unmount();
    });

    it('reads the author\'s committed expiry while the activation does not exist yet', async () => {
        const expiresAt = new Date(2030, 0, 2, 3, 4).getTime();
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('preparing')}
            pendingPackageExpiresAt={expiresAt}
        />);

        expect(JSON.stringify(screen.findByTestId('temporary-computer-package-expiry')?.props.children))
            .toContain(new Date(expiresAt).toLocaleString());
        await screen.unmount();
    });

    it('stops advertising an expiry once the request has settled', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('failed', 'closed', 'declined')}
        />);

        expect(screen.findByTestId('temporary-computer-package-expiry')).toBeNull();
        await screen.unmount();
    });

    it('renders waiting actions as accessible controls', async () => {
        const value = controller('waiting_for_computer');
        const onExportPackage = vi.fn();
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} onExportPackage={onExportPackage} />);

        expect(screen.findByTestId('temporary-computer-launch-progress')?.props.accessibilityRole).toBe('progressbar');
        expect(screen.findByTestId('temporary-computer-launch-surface')?.props.accessibilityRole).toBeUndefined();
        await screen.pressByTestIdAsync('temporary-computer-export');
        await screen.pressByTestIdAsync('temporary-computer-cancel');
        expect(onExportPackage).toHaveBeenCalledOnce();
        expect(value.cancel).toHaveBeenCalledOnce();
    });

    it('suppresses a double press while one package export is still in flight', async () => {
        const exportCompletion = createDeferred<void>();
        const onExportPackage = vi.fn(async () => exportCompletion.promise);
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer')}
            onExportPackage={onExportPackage}
        />);

        // This interaction is intentionally concurrent. The async press helper
        // owns one React `act()` until the handler settles, so starting a second
        // helper call would create overlapping global act scopes and contaminate
        // every test that follows. A synchronous host press models the second tap
        // while the first promise remains pending without creating a second act.
        screen.pressByTestId('temporary-computer-export');
        screen.pressByTestId('temporary-computer-export');
        expect(onExportPackage).toHaveBeenCalledTimes(1);

        exportCompletion.resolve(undefined);
        await flushHookEffects();
        screen.pressByTestId('temporary-computer-export');
        expect(onExportPackage).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });

    it('keeps the package action mounted and exposes progress while export is in flight', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer', 'pending')}
            packageCustodyOnThisDevice
            packageExportState={{ status: 'exporting', activationId: 'activation-1', error: null }}
            onExportPackage={vi.fn(async () => undefined)}
        />);

        const exportAction = screen.findByTestId('temporary-computer-export');
        expect(exportAction).not.toBeNull();
        expect(exportAction?.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
        await screen.unmount();
    });

    it('keeps package export failure visible with creator-device guidance', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer')}
            createdOnDeviceLabel="Alice's iPhone"
            packageExportState={{ status: 'failed', activationId: 'activation-1', error: new Error('disk full') }}
            onExportPackage={vi.fn(async () => undefined)}
        />);

        expect(screen.findByTestId('temporary-computer-package-export-error')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-package-export-device')?.props.children).toBe("Alice's iPhone");
    });

    it('tells a non-creating device to continue there or cancel and create a new package here', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer')}
            createdOnDeviceLabel="Alice's iPhone"
            packageAvailableOnThisDevice={false}
        />);

        expect(screen.findByTestId('temporary-computer-export')).toBeNull();
        // The two real options, stated. The generic "prepare a package"
        // subtitle is an instruction this device cannot carry out.
        expect(screen.findByTestId('temporary-computer-other-device-guidance')?.props.children)
            .toBe('newSession.temporaryComputer.otherDevice.guidance');
        // The device name is a fact about where the package lives, not a bare
        // label that can read as "This device" on the wrong device.
        expect(screen.findByTestId('temporary-computer-package-export-device')?.props.children)
            .toBe("newSession.temporaryComputer.otherDevice.createdOn(device=Alice's iPhone)");
        // Cancelling here is the second option the guidance names.
        expect(screen.findByTestId('temporary-computer-cancel')).not.toBeNull();
    });

    it('keeps offline cancellation visible with retry and cancel', async () => {
        const value = controller('cancel_failed');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-launch-surface')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-retry')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-cancel')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-launch-progress')?.props.accessibilityLiveRegion).toBe('assertive');
    });

    it('offers the creator an in-place retry when review dependencies are temporarily unavailable', async () => {
        const value = controller('review_unavailable');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} packageCustodyOnThisDevice />);

        expect(screen.findByTestId('temporary-computer-launch-status')?.props.children)
            .toBe('newSession.temporaryComputer.status.review_unavailable');
        expect(screen.findByTestId('temporary-computer-retry')).not.toBeNull();
        await screen.pressByTestIdAsync('temporary-computer-retry');
        expect(value.retry).toHaveBeenCalledOnce();
        expect(value.start).not.toHaveBeenCalled();
        expect(screen.findByTestId('temporary-computer-cancel')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-launch-progress')?.props.accessibilityLiveRegion).toBe('assertive');
        await screen.unmount();
    });

    it('keeps an observing device inspect-and-cancel only when creator review is unavailable here', async () => {
        const value = controller('review_unavailable', 'claimed');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={value}
            packageCustodyOnThisDevice={false}
            packageAvailableOnThisDevice={false}
        />);

        expect(screen.findByTestId('temporary-computer-retry')).toBeNull();
        expect(screen.findByTestId('temporary-computer-cancel')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-other-device-guidance')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-launch-progress')?.props.accessibilityLiveRegion).toBe('polite');
        await screen.unmount();
    });

    // Retry cannot resolve a Profile the target Account no longer has, and the
    // frozen submission hides the only control that can: the composer.
    it.each([
        ['profile_changed', 'runner_profile_selection_changed'],
        ['profile_environment_unavailable', 'runner_profile_environment_unavailable'],
    ] as const)('offers only Return to editing for the %s incompatibility', async (status, code) => {
        const value: TemporaryComputerLaunchController = {
            ...controller(status),
            error: Object.assign(new Error(code), { code }),
        };
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-launch-status')?.props.children)
            .toBe(`newSession.temporaryComputer.status.${status}`);
        expect(screen.findByTestId('temporary-computer-launch-progress')?.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.findByTestId('temporary-computer-retry')).toBeNull();
        expect(screen.findByTestId('temporary-computer-cancel')).toBeNull();
        // Nothing was ever frozen into a package, so an expiry line would
        // describe something that does not exist.
        expect(screen.findByTestId('temporary-computer-package-expiry')).toBeNull();

        const returnToEditing = screen.findByTestId('temporary-computer-return-to-editing');
        expect(returnToEditing?.props.accessibilityLabel).toBe('newSession.temporaryComputer.returnToEditing');
        await screen.pressByTestIdAsync('temporary-computer-return-to-editing');
        expect(value.dismissTerminal).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('keeps generic retry and cancel for a transient launch failure', async () => {
        const value = controller('failed');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-retry')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-cancel')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-return-to-editing')).toBeNull();
        await screen.unmount();
    });

    it('identifies a missing materialization producer separately from a missing review producer', async () => {
        const value = controller('materialization_unavailable');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-launch-status')?.props.children)
            .toBe('newSession.temporaryComputer.status.materialization_unavailable');
        expect(screen.findByTestId('temporary-computer-cancel')).not.toBeNull();
    });

    it('offers only local cleanup retry — never a dead Cancel — once the server acknowledged closure', async () => {
        const value = controller('cancel_failed', 'closed');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-retry')).not.toBeNull();
        expect(screen.findByTestId('temporary-computer-cancel')).toBeNull();
    });

    it('shows the exact acknowledged close and offers a real replacement package action', async () => {
        const value = controller('failed', 'closed', 'declined');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-retry')).toBeNull();
        expect(screen.findByTestId('temporary-computer-cancel')).toBeNull();
        expect(screen.findByTestId('temporary-computer-terminal-reason')?.props.children)
            .toBe('newSession.temporaryComputer.closed.declined');
        await screen.pressByTestIdAsync('temporary-computer-terminal-new-package');
        expect(value.replaceTerminal).toHaveBeenCalledOnce();
    });

    it('never offers cancel after the Session materialized', async () => {
        const value = controller('succeeded', 'materialized');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-cancel')).toBeNull();
        expect(screen.findByTestId('temporary-computer-export')).toBeNull();
    });

    it('cancels an unclaimed request immediately without adding confirmation ceremony', async () => {
        modalMock.confirm.mockClear();
        const value = controller('waiting_for_computer', 'pending');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        await screen.pressByTestIdAsync('temporary-computer-cancel');

        expect(modalMock.confirm).not.toHaveBeenCalled();
        expect(value.cancel).toHaveBeenCalledOnce();
    });

    it('requires explicit confirmation after the endpoint connected or consented', async () => {
        modalMock.confirm.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const value = controller('waiting_for_approval', 'claimed');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        await screen.pressByTestIdAsync('temporary-computer-cancel');
        expect(value.cancel).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('temporary-computer-cancel');

        expect(modalMock.confirm).toHaveBeenCalledTimes(2);
        expect(value.cancel).toHaveBeenCalledOnce();
    });

    it('announces a semantic phase change once on iOS without repeating on refetch', async () => {
        platformMock.os = 'ios';
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={controller('reconciling')} />);

        // The phase a reopened surface mounts with is already on screen: like
        // every other platform's live region, iOS does not re-speak it.
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();

        // A refetch that leaves the semantic phase unchanged stays silent.
        await screen.update(<TemporaryComputerLaunchSurface controller={controller('reconciling')} />);
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();

        await screen.update(<TemporaryComputerLaunchSurface controller={controller('waiting_for_computer')} />);
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('newSession.temporaryComputer.status.waiting_for_computer');

        await screen.update(<TemporaryComputerLaunchSurface controller={controller('waiting_for_computer')} />);
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('announces a fresh launch once on iOS when the surface mounts for it, then each phase once', async () => {
        platformMock.os = 'ios';
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        // The composer mounts this surface only once the user has pressed Launch,
        // so `preparing` at mount is the launch starting, not a state already heard.
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={controller('preparing')} />);

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('newSession.temporaryComputer.status.preparing');

        await screen.update(<TemporaryComputerLaunchSurface controller={controller('preparing')} />);
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);

        await screen.update(<TemporaryComputerLaunchSurface controller={controller('waiting_for_computer')} />);
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('newSession.temporaryComputer.status.waiting_for_computer');
        await screen.unmount();
    });

    it('announces a failure transition on iOS with its terminal reason', async () => {
        platformMock.os = 'ios';
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={controller('waiting_for_computer')} />);
        await screen.update(<TemporaryComputerLaunchSurface controller={controller('cancel_failed')} />);

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('newSession.temporaryComputer.status.cancel_failed');
        await screen.unmount();
    });

    it('keeps web and Android announcements on the declarative live region', async () => {
        platformMock.os = 'android';
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={controller('preparing')} />);

        expect(announceForAccessibilityMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('temporary-computer-launch-progress')?.props.accessibilityLiveRegion).toBe('polite');
        await screen.unmount();
    });

    // The person holding this screen has to be able to answer "where is this
    // going?" at any moment — a package already on someone else's computer is not
    // described by whatever the composer happens to hold now.
    it.each([
        'preparing',
        'waiting_for_computer',
        'waiting_for_approval',
        'connected',
        'installing_agent',
        'checking_ai_access',
        'preparing_encryption',
        'creating_session',
        'cancel_failed',
    ] as const)('keeps stating the exact destination through the %s phase', async (status) => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller(status)}
            target={{
                homeLabel: 'Work',
                accountLabel: null,
                artifactTarget: 'linux-x64',
                workspace: 'choose_on_endpoint',
            }}
        />);

        expect(screen.findByTestId('temporary-computer-launch-status')?.props.children)
            .toBe(`newSession.temporaryComputer.status.${status}`);
        expect(screen.findByTestId('temporary-computer-target-platform')?.props.children)
            .toBe('newSession.temporaryComputer.platform.linux-x64');
        expect(screen.findByTestId('temporary-computer-target-home')?.props.children)
            .toBe('newSession.temporaryComputer.target.home(home=Work)');
        expect(screen.findByTestId('temporary-computer-target-workspace')?.props.children)
            .toBe('newSession.temporaryComputer.target.workspaceChoose');
        // An exact ID is secondary: it appears only when the request does not
        // belong to the Account in focus and the scope would otherwise be
        // ambiguous.
        expect(screen.findByTestId('temporary-computer-target-account')).toBeNull();
        await screen.unmount();
    });

    it('qualifies the Account for a request that is not in the active scope', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer')}
            target={{
                homeLabel: 'Work',
                accountLabel: 'acc_other',
                artifactTarget: 'windows-x64',
                workspace: 'endpoint_home',
            }}
        />);

        expect(screen.findByTestId('temporary-computer-target-account')?.props.children)
            .toBe('newSession.temporaryComputer.target.account(account=acc_other)');
        expect(screen.findByTestId('temporary-computer-target-workspace')?.props.children)
            .toBe('newSession.temporaryComputer.target.workspaceHome');
        await screen.unmount();
    });

    it('names an unrecognized published platform instead of printing its wire value', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer')}
            target={{
                homeLabel: null,
                accountLabel: null,
                artifactTarget: 'solaris-sparc',
                workspace: null,
            }}
        />);

        expect(screen.findByTestId('temporary-computer-target-platform')?.props.children)
            .toBe('newSession.temporaryComputer.platform.unknown');
        expect(screen.findByTestId('temporary-computer-target-home')).toBeNull();
        await screen.unmount();
    });

    // Removing the control at claim hid the reason the package cannot be sent
    // again, and destroyed whatever the keyboard was on at the exact moment the
    // phase changed. It stays, disabled, and says why.
    it('disables package export with its reason once a computer claimed the request', async () => {
        const value = controller('waiting_for_approval', 'claimed');
        (value.projection as unknown as { claim?: unknown }).claim = { payload: {}, signature: 'signature' };
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={value}
            packageCustodyOnThisDevice
        />);

        const exportAction = screen.findByTestId('temporary-computer-export');
        expect(exportAction).not.toBeNull();
        expect(exportAction?.props.accessibilityState.disabled).toBe(true);
        expect(screen.findByTestId('temporary-computer-export-claimed')?.props.children)
            .toBe('newSession.temporaryComputer.exportClaimed');
        await screen.unmount();
    });

    it('keeps the export control mounted across the claim transition', async () => {
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const waiting = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer', 'pending')}
            packageCustodyOnThisDevice
            onExportPackage={vi.fn(async () => undefined)}
        />);
        const exportControl = waiting.findHostByTestId('temporary-computer-export');
        expect(exportControl).not.toBeNull();
        expect(exportControl?.props.accessibilityState.disabled).toBe(false);

        const claimed = controller('creating_session', 'consented');
        (claimed.projection as unknown as { claim?: unknown }).claim = { payload: {}, signature: 'signature' };
        await waiting.update(<TemporaryComputerLaunchSurface
            controller={claimed}
            packageCustodyOnThisDevice
        />);
        expect(waiting.findHostByTestId('temporary-computer-export')).toBe(exportControl);
        expect(exportControl?.props.accessibilityState.disabled).toBe(true);
        await waiting.unmount();
    });

    it('keeps materialized recovery retryable without offering cancellation', async () => {
        const value = controller('failed', 'materialized');
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        await screen.pressByTestIdAsync('temporary-computer-retry');
        expect(value.retry).toHaveBeenCalledOnce();
        expect(screen.findByTestId('temporary-computer-cancel')).toBeNull();
        await screen.unmount();
    });

    it('lets the creator leave a materialized recovery failure while preserving the draft', async () => {
        const onContinueLater = vi.fn();
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('failed', 'materialized')}
            onContinueLater={onContinueLater}
        />);

        await screen.pressByTestIdAsync('temporary-computer-continue-later');
        expect(onContinueLater).toHaveBeenCalledOnce();
        expect(screen.findByTestId('temporary-computer-cancel')).toBeNull();
        await screen.unmount();
    });

    it('lets the creator continue later while the waiting draft remains active', async () => {
        const onContinueLater = vi.fn();
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface
            controller={controller('waiting_for_computer', 'pending')}
            onContinueLater={onContinueLater}
        />);

        await screen.pressByTestIdAsync('temporary-computer-continue-later');
        expect(onContinueLater).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('says when this device cannot read the details the computer sent', async () => {
        const value = controller('waiting_for_approval', 'claimed');
        (value.projection as unknown as { endpointFacts?: unknown }).endpointFacts = {
            status: 'unavailable',
            reason: 'recipient_mismatch',
        };
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-endpoint-facts-unreadable')?.props.children)
            .toBe('newSession.temporaryComputer.endpointFacts.unreadable');
        await screen.unmount();
    });

    it('stays silent about endpoint details it can read', async () => {
        const value = controller('waiting_for_approval', 'claimed');
        (value.projection as unknown as { endpointFacts?: unknown }).endpointFacts = {
            status: 'available',
            facts: {},
        };
        const { TemporaryComputerLaunchSurface } = await import('./TemporaryComputerLaunchSurface');
        const screen = await renderScreen(<TemporaryComputerLaunchSurface controller={value} />);

        expect(screen.findByTestId('temporary-computer-endpoint-facts-unreadable')).toBeNull();
        await screen.unmount();
    });

    it('keeps creator-surface translations present in every locale', async () => {
        const { en } = await import('../../../../text/translations/en');
        const { ru } = await import('../../../../text/translations/ru');
        const { pl } = await import('../../../../text/translations/pl');
        const { es } = await import('../../../../text/translations/es');
        const { fr } = await import('../../../../text/translations/fr');
        const { it: itLocale } = await import('../../../../text/translations/it');
        const { pt } = await import('../../../../text/translations/pt');
        const { ca } = await import('../../../../text/translations/ca');
        const { de } = await import('../../../../text/translations/de');
        const { zhHans } = await import('../../../../text/translations/zh-Hans');
        const { zhHant } = await import('../../../../text/translations/zh-Hant');
        const { ja } = await import('../../../../text/translations/ja');
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ] as const;
        const requiredKeys = [
            'newSession.temporaryComputer.createNewPackage',
            'newSession.temporaryComputer.exportClaimed',
            'newSession.temporaryComputer.target.workspaceChoose',
            'newSession.temporaryComputer.target.workspaceHome',
            'newSession.temporaryComputer.endpointFacts.unreadable',
            'newSession.temporaryComputer.returnToEditing',
            'newSession.temporaryComputer.status.profile_changed',
            'newSession.temporaryComputer.status.profile_environment_unavailable',
            'newSession.temporaryComputer.closed.canceled',
            'newSession.temporaryComputer.closed.declined',
            'newSession.temporaryComputer.closed.expired',
            'newSession.temporaryComputer.closed.revoked',
            'newSession.temporaryComputer.closed.failed',
            'newSession.profileReasonNotPortable',
            'newSession.connectedServicesReasonNotPortable',
            'newSession.mcpReasonNotPortable',
        ] as const;
        const readLeaf = (root: unknown, key: string): unknown => key.split('.').reduce<unknown>(
            (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
            root,
        );
        for (const key of requiredKeys) {
            expect(typeof readLeaf(en, key)).toBe('string');
        }
        const failures: string[] = [];
        for (const { code, root } of locales) {
            for (const key of requiredKeys) {
                const value = readLeaf(root, key);
                if (typeof value !== 'string' || value.trim().length === 0) {
                    failures.push(`${code}: ${key} is missing`);
                }
            }
        }
        expect(failures).toEqual([]);
    });
});
