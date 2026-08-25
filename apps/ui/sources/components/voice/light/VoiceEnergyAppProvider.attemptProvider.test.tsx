import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

import { useVoiceEnergyPresence } from './useVoiceEnergy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = vi.hoisted(() => ({
    voice: { providerId: null } as unknown,
    snapshot: {
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
    } as VoiceSessionSnapshot,
}));

const hostPresence = vi.hoisted(() => ({
    activelyViewed: true,
    activelyFocused: true,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => runtime.voice,
}));

vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => runtime.snapshot,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/utils/runtime/useHostActivelyViewed', () => ({
    useHostActivelyViewed: () => hostPresence.activelyViewed,
    useHostActivelyFocused: () => hostPresence.activelyFocused,
}));

/** A mounted Voice surface: the energy clock only runs while one is present. */
function VisibleConsumer(): null {
    const presence = useVoiceEnergyPresence();
    React.useEffect(() => {
        presence.acquire();
        return () => presence.release();
    }, [presence]);
    return null;
}

function latestFrameActivation(): boolean | null {
    const records = readReanimatedFrameCallbacks();
    expect(records).toHaveLength(1);
    return records[0]!.setActiveCalls.at(-1) ?? null;
}

/**
 * §2.4a's activation gate reads "a provider is resolved". That fact must come from the attempt
 * that is running, not from the selection: the selection names the *next* idle admission, so a
 * user who picks Off mid-conversation would otherwise freeze the light — the presence would stop
 * breathing, stop showing amplitude and stop settling while the microphone stayed open.
 */
describe('VoiceEnergyAppProvider attempt provider', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        runtime.voice = { providerId: null };
        runtime.snapshot = {
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        hostPresence.activelyViewed = true;
        hostPresence.activelyFocused = true;
    });

    afterEach(() => {
        act(() => tree?.unmount());
        tree = null;
    });

    async function renderProvider(): Promise<void> {
        const { VoiceEnergyAppProvider } = await import('./VoiceEnergyAppProvider');
        await act(async () => {
            tree = renderer.create(
                <VoiceEnergyAppProvider>
                    <VisibleConsumer />
                </VoiceEnergyAppProvider>,
            );
        });
    }

    it('keeps the energy clock running for a live attempt after the selection changes to Off', async () => {
        runtime.voice = { providerId: 'off' };
        runtime.snapshot = {
            adapterId: 'local_conversation',
            sessionId: 'voice-attempt',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };

        await renderProvider();

        expect(latestFrameActivation()).toBe(true);
    });

    it('leaves the clock idle when nothing is running and nothing is selected', async () => {
        runtime.voice = { providerId: 'off' };

        await renderProvider();

        expect(latestFrameActivation()).toBe(false);
    });

    it('stays still when a desktop window remains visible but loses focus', async () => {
        runtime.voice = { providerId: 'local_conversation' };
        runtime.snapshot = {
            adapterId: 'local_conversation',
            sessionId: 'voice-attempt',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        };
        // Context and other visible-window consumers still receive this fact. The
        // energy clock is the narrower focus projection, so it must stop here.
        hostPresence.activelyViewed = true;
        hostPresence.activelyFocused = false;

        await renderProvider();

        expect(latestFrameActivation()).toBe(false);
    });
});
