import * as React from 'react';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { CaptureWindowKeyboard } from '../window/CaptureWindowKeyboard';
import { RecordingControlWindow } from './RecordingControlWindow';
import { RECORDING_CONTROL_HEIGHT } from './RecordingControlBar';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

describe('recording pill keyboard focus', () => {
    let browser: JSDOM | undefined;
    afterEach(async () => { await standardCleanup(); browser?.window.close(); vi.unstubAllGlobals(); });
    it.each(['recording', 'paused', 'finalizing'] as const)('Space controls only the focused %s pill', async phase => {
        browser = new JSDOM('<body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        vi.stubGlobal('HTMLElement', browser.window.HTMLElement);
        vi.stubGlobal('Node', browser.window.Node);
        const onPause = vi.fn();
        const onResume = vi.fn();
        const onPresent = vi.fn();
        const screen = await renderScreen(<CaptureWindowKeyboard><RecordingControlWindow
            snapshot={{ phase, timing: { durationMs: 1000, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null }}
            area={null} workArea={{ x: 0, y: 0, width: 1440, height: 900 }} discarded={false}
            onPresent={onPresent} onPause={onPause} onResume={onResume} onStop={() => {}}
            onDiscard={() => {}} onDiscardHoldEnded={() => {}}
        /></CaptureWindowKeyboard>);
        const pressSpace = () => document.dispatchEvent(new browser!.window.KeyboardEvent('keydown', {
            key: ' ', code: 'Space', bubbles: true, cancelable: true,
        }));
        await act(async () => { pressSpace(); });
        expect(onPause).not.toHaveBeenCalled();
        expect(onResume).not.toHaveBeenCalled();
        const pill = screen.findAll(node => node.props.testID === 'capture-recording-chrome' && typeof node.type === 'string')[0]!;
        await act(async () => { pill.props.onLayout({ nativeEvent: { layout: { width: 253, height: RECORDING_CONTROL_HEIGHT } } }); });
        expect(onPresent.mock.lastCall?.[0]).toMatchObject({ width: 253, height: RECORDING_CONTROL_HEIGHT });
        // The control fills its window, so the app's glass behind it follows the control's radius.
        expect(onPresent.mock.lastCall?.[1]).toBe(RECORDING_CONTROL_HEIGHT / 2);
        await act(async () => { pill.props.onFocus(); });
        const pillElement = document.createElement('div');
        const childControl = document.createElement('button');
        pillElement.append(childControl);
        await act(async () => { pill.props.onBlur({ currentTarget: pillElement, relatedTarget: childControl }); });
        await act(async () => { pressSpace(); });
        expect(onPause).toHaveBeenCalledTimes(phase === 'recording' ? 1 : 0);
        expect(onResume).toHaveBeenCalledTimes(phase === 'paused' ? 1 : 0);
        await act(async () => { pill.props.onBlur({ currentTarget: pillElement, relatedTarget: null }); });
        await act(async () => { pressSpace(); });
        expect(onPause).toHaveBeenCalledTimes(phase === 'recording' ? 1 : 0);
        expect(onResume).toHaveBeenCalledTimes(phase === 'paused' ? 1 : 0);
    });
});
