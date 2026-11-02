import * as React from 'react';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { BrowserRecordingCapsule } from './BrowserRecordingCapsule';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

function recordingSession(startedAtMs: number): BrowserRecordingSessionV1 {
    return {
        v: 1,
        recordingId: 'recording_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        profileId: 'profile_1',
        targetKind: 'externalUrl',
        adapterKind: 'externalUrl',
        renderEngineKind: 'desktopWebView',
        captureKind: 'nativeViewCapture',
        fidelity: 'nativeCallback',
        startedAtMs,
        status: 'recording',
        navigationGenerationStart: 2,
        durationMs: 0,
        byteSize: 0,
        frameCount: 0,
        fps: 12,
        mimeType: 'video/webm',
        retentionClass: 'preSend',
        redactionLevel: 'metadataOnly',
        policyState: 'allowed',
        actionChapters: [],
        relatedReferences: [],
    } as BrowserRecordingSessionV1;
}

describe('BrowserRecordingCapsule', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the elapsed time ticking without any other re-render and never shows capture fidelity (H-UX F-25, F-6)', async () => {
        vi.useFakeTimers();
        const screen = await renderScreen(
            <BrowserRecordingCapsule testID="recording" recording={recordingSession(Date.now())} onStop={vi.fn()} />,
        );
        expect(screen.getTextContent()).toContain('0:00');

        await act(async () => {
            vi.advanceTimersByTime(3_000);
        });

        expect(screen.getTextContent()).toContain('0:03');
        expect(screen.getTextContent()).not.toContain('fidelity');
    });

    it('stops the recording it shows', async () => {
        const onStop = vi.fn();
        const recording = recordingSession(Date.now());
        const screen = await renderScreen(<BrowserRecordingCapsule testID="recording" recording={recording} onStop={onStop} />);
        await screen.pressByTestIdAsync('recording-stop');
        expect(onStop).toHaveBeenCalledWith(recording);
    });
});
