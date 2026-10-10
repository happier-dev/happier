import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { ComputerTargetPicker, computerTargetKey, resolveSuggestedTargetKey, type ComputerTargetPickerState } from './ComputerTargetPicker';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

const lumen = { target: { kind: 'window', displayId: ':0', pid: 10, windowId: 1 }, title: 'Sign in to Lumen' } as const;
const screenTarget = { target: { kind: 'display', displayId: ':0' } } as const;
const ready: ComputerTargetPickerState = { kind: 'ready', targets: [lumen, screenTarget], grants: { capture: 'granted', input: 'granted' } };

function renderPicker(overrides: Partial<React.ComponentProps<typeof ComputerTargetPicker>> = {}) {
    const props: React.ComponentProps<typeof ComputerTargetPicker> = {
        machineName: 'Studio laptop', state: ready, selectedKey: null, onSelect: vi.fn(), sharing: false, noticeCode: null,
        canStopSharing: false, onShare: vi.fn(), onStopSharing: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(),
        onOpenSettings: vi.fn(), openSettings: 'idle', testID: 'p',
        agentName: 'Claude', policy: { asksBeforeScreenshots: true, asksBeforeInput: false }, onChangePolicy: vi.fn(),
        access: 'use', onAccessChange: vi.fn(), ...overrides,
    };
    return { props, screen: renderScreen(<ComputerTargetPicker {...props} />) };
}

describe('resolveSuggestedTargetKey', () => {
    it('finds the listed window an agent’s hint names, and nothing when no title contains it', () => {
        expect(resolveSuggestedTargetKey([screenTarget, lumen], 'lumen')).toBe(computerTargetKey(lumen.target));
        expect(resolveSuggestedTargetKey([screenTarget, lumen], 'Figma')).toBeNull();
        expect(resolveSuggestedTargetKey([lumen], '  ')).toBeNull();
    });
});

describe('ComputerTargetPicker', () => {
    it('shows owner app and display facts, previews the window, and lets the person choose see-only access', async () => {
        const appWindow = { ...lumen, appName: 'Lumen', thumbnail: { mimeType: 'image/png' as const, base64: 'cG5n', width: 200, height: 120 } };
        const display = { ...screenTarget, label: 'Built-in display', width: 1920, height: 1080 };
        const { props, screen: pending } = renderPicker({
            selectedKey: computerTargetKey(appWindow.target),
            state: { ...ready, kind: 'ready', targets: [appWindow, display], grants: { capture: 'granted', input: 'granted' } },
        });
        const screen = await pending;
        expect(screen.getTextContent()).toContain('Built-in display');
        expect(screen.getTextContent()).toContain('Lumen');
        expect(screen.findByTestId('p-thumbnail:window')?.props.source).toMatchObject({ uri: 'data:image/png;base64,cG5n' });
        await screen.pressByTestIdAsync('p-access:see');
        expect(props.onAccessChange).toHaveBeenCalledWith('see');
    });

    it('starts on the agent’s suggestion, says so on its row, and lets the person pick another', async () => {
        const key = computerTargetKey(lumen.target);
        const { props, screen: pending } = renderPicker({ suggestedKey: key, selectedKey: key });
        const screen = await pending;
        expect(screen.getTextContent()).toContain('computerUse.picker.suggests');
        expect(screen.findByTestId('p-share')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('p-target:display');
        expect(props.onSelect).toHaveBeenCalledWith(computerTargetKey(screenTarget.target));
    });

    it('lists the machine’s windows and screens, chooses nothing itself, and shares only what the person picked', async () => {
        const { props, screen: pending } = renderPicker();
        const screen = await pending;
        const text = screen.getTextContent();
        expect(text).toContain('Sign in to Lumen');
        expect(text).toContain('computerUse.picker.screenLabel');
        expect(screen.findByTestId('p-share')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('p-target:window');
        expect(props.onSelect).toHaveBeenCalledWith(computerTargetKey(lumen.target));
        // The ask-first line says the person's own Actions preference, and Change opens it.
        expect(text).toContain('computerUse.picker.policyCapture');
        await screen.pressByTestIdAsync('p-policy-change');
        expect(props.onChangePolicy).toHaveBeenCalledTimes(1);
    });

    it('shows the missing OS permission instead of an empty list, and opens it on that machine', async () => {
        const { props, screen: pending } = renderPicker({ state: { kind: 'ready', targets: [], grants: { capture: 'denied', input: 'granted' } } });
        const screen = await pending;
        expect(screen.findByTestId('p-permission')).toBeTruthy();
        await screen.pressByTestIdAsync('computer-permission-open-settings');
        expect(props.onOpenSettings).toHaveBeenCalledWith('capture');
    });

    it('allows a see-only share when capture is granted but input is denied', async () => {
        const { screen: pending } = renderPicker({ access: 'see', state: {
            kind: 'ready', targets: [lumen], grants: { capture: 'granted', input: 'denied' },
        } });
        const screen = await pending;
        expect(screen.findByTestId('p-target:window')).toBeTruthy();
        expect(screen.findByTestId('p-permission')).toBeNull();
    });

    it('keeps unknown capture readiness first instead of treating a denied input grant as the viewing failure', async () => {
        const { props, screen: pending } = renderPicker({ state: {
            kind: 'ready', targets: [], grants: { capture: 'unknown', input: 'denied' },
        } });
        const screen = await pending;
        await screen.pressByTestIdAsync('computer-permission-open-settings');
        expect(props.onOpenSettings).toHaveBeenCalledWith('capture');
    });

    it('explains the owner’s display refusal without making a whole display selectable', async () => {
        const screen = await renderPicker({ state: {
            kind: 'ready', targets: [lumen], grants: { capture: 'granted', input: 'granted' },
            displays: { status: 'unavailable', code: 'display_enumeration_unsupported' },
        } }).screen;
        expect(screen.findByTestId('p-displays-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('computerUse.picker.displayUnavailable');
        expect(screen.findByTestId('p-target:display')).toBeNull();
        expect(screen.findByTestId('p-target:window')).toBeTruthy();
        const empty = await renderPicker({ state: {
            kind: 'ready', targets: [], grants: { capture: 'granted', input: 'granted' },
            displays: { status: 'unavailable', code: 'display_enumeration_unsupported' },
        } }).screen;
        expect(empty.findByTestId('p-displays-unavailable')).toBeTruthy();
        expect(empty.findByTestId('p-target:display')).toBeNull();
    });

    it('asks before a whole display is shared, with viewing and input as separate grants, and shares a window at once', async () => {
        const display = { ...screenTarget, label: 'Built-in display', width: 2560, height: 1600 };
        const state: ComputerTargetPickerState = { kind: 'ready', targets: [lumen, display], grants: { capture: 'granted', input: 'granted' } };
        const displayKey = computerTargetKey(display.target);
        const forDisplay = renderPicker({ state, selectedKey: displayKey, access: 'see' });
        const screen = await forDisplay.screen;
        expect(screen.findByTestId('p-display-consent')).toBeNull();
        await screen.pressByTestIdAsync('p-share');
        // Nothing is shared by choosing: the consent says what a display exposes first.
        expect(forDisplay.props.onShare).not.toHaveBeenCalled();
        expect(screen.findByTestId('p-display-consent')).toBeTruthy();
        expect(screen.getTextContent()).toContain('computerUse.picker.wholeDisplayBody:{"display":"Built-in display"}');
        await screen.pressByTestIdAsync('p-display-consent-share');
        expect(forDisplay.props.onShare).toHaveBeenCalledWith({ key: displayKey, access: 'see' });

        const forWindow = renderPicker({ state, selectedKey: computerTargetKey(lumen.target) });
        const windowScreen = await forWindow.screen;
        await windowScreen.pressByTestIdAsync('p-share');
        expect(windowScreen.findByTestId('p-display-consent')).toBeNull();
        expect(forWindow.props.onShare).toHaveBeenCalledWith();
    });

    it('as the viewer’s switcher, watches a window at the press, marks what is shared and offers no form', async () => {
        const other = { target: { kind: 'window', displayId: ':0', pid: 11, windowId: 2 }, title: 'Xcode', appName: 'Xcode' } as const;
        const display = { ...screenTarget, label: 'Display 1', width: 2560, height: 1600 };
        const state: ComputerTargetPickerState = { kind: 'ready', targets: [lumen, other, display], grants: { capture: 'granted', input: 'granted' } };
        // The shared window is the first row; the press below reaches the last window row, another window.
        const currentKey = computerTargetKey(lumen.target);
        const { props, screen: pending } = renderPicker({ state, density: 'switcher', currentKey, selectedKey: currentKey, access: 'see' });
        const screen = await pending;
        const text = screen.getTextContent();
        expect(text).toContain('computerUse.picker.usingIt');
        expect(text).toContain('computerUse.picker.displayShared');
        expect(text).toContain('computerUse.picker.footnote');
        // The rows are the action: no access form, no policy line, no Share or Cancel.
        expect(screen.findByTestId('p-share')).toBeNull();
        expect(screen.findByTestId('p-cancel')).toBeNull();
        expect(screen.findByTestId('p-access')).toBeNull();
        expect(screen.findByTestId('p-policy')).toBeNull();
        await screen.pressByTestIdAsync('p-refresh');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('p-target:window');
        expect(props.onShare).toHaveBeenCalledWith({ key: computerTargetKey(other.target), access: 'see' });
        // A whole display still asks first.
        await screen.pressByTestIdAsync('p-target:display');
        expect(props.onShare).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('p-display-consent')).toBeTruthy();
    });

    it('says plainly when the machine has no screen, and why a share did not land', async () => {
        const headless = await renderPicker({ state: { kind: 'failed', code: 'computer_display_unavailable' } }).screen;
        expect(headless.getTextContent()).toContain('computerUse.picker.noScreenTitle');
        const inUse = await renderPicker({ selectedKey: computerTargetKey(lumen.target), noticeCode: 'computer_target_in_use' }).screen;
        expect(inUse.getTextContent()).toContain('computerUse.picker.inUse');
        // Computer use targets the Session's own machine: another machine is a typed refusal, no list.
        const other = await renderPicker({ state: { kind: 'failed', code: 'computer_machine_mismatch' } }).screen;
        expect(other.getTextContent()).toContain('computerUse.picker.otherMachineTitle');
        expect(other.findByTestId('p-share')).toBeNull();
    });
});
