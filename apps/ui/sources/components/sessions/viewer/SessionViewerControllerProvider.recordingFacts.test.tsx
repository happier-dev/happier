import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { useOptionalSessionViewerController, type SessionViewerController, type SessionViewerSourceFacts } from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

describe('SessionViewerControllerProvider facts', () => {
    it('publishes a recorder change, the only fact that differs, so the viewer shows the running capsule', async () => {
        let controller: SessionViewerController | null = null;
        function Probe() {
            controller = useOptionalSessionViewerController();
            return null;
        }
        await renderScreen(
            <SessionViewerControllerProvider phone={false} sessionId="session-1" serverId="server-1" canPresentSource={() => true} openDocked={() => {}}>
                <Probe />
            </SessionViewerControllerProvider>,
        );
        const base: SessionViewerSourceFacts = { machineName: 'Studio', personInControl: false };
        const recording = { recording: null, onStart: () => {}, onStop: () => {}, onDiscard: () => {} };
        await act(async () => { controller?.publishFacts('computer', { ...base, recording: null }); });
        await act(async () => { controller?.publishFacts('computer', { ...base, recording }); });
        expect(controller!.facts.computer?.recording).toBe(recording);
    });
});
