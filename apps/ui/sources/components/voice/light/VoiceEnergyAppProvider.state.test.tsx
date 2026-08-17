import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import {
    voiceRuntimeLevelStore,
    type VoiceRuntimeLevelWriter,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

import { resolveVoiceEnergyState } from './resolveVoiceEnergyState';
import { useVoiceEnergy, type VoiceEnergy, type VoiceEnergyState } from './useVoiceEnergy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime = vi.hoisted(() => ({
    snapshot: {
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
    } as VoiceSessionSnapshot,
}));

const observed = { energy: null as VoiceEnergy | null };

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => ({ providerId: null }),
}));

vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => runtime.snapshot,
}));

function EnergyProbe(): null {
    observed.energy = useVoiceEnergy();
    return null;
}

describe('VoiceEnergyAppProvider state bridge', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let inputWriter: VoiceRuntimeLevelWriter | null = null;

    afterEach(() => {
        act(() => tree?.unmount());
        inputWriter?.close();
        inputWriter = null;
        tree = null;
        observed.energy = null;
    });

    async function project(
        snapshot: VoiceSessionSnapshot,
        inputSourceActive = false,
    ): Promise<Pick<VoiceEnergyState, 'luminosity' | 'energized'>> {
        runtime.snapshot = snapshot;
        if (inputSourceActive) {
            inputWriter = voiceRuntimeLevelStore.open({
                channel: 'input',
                sourceId: 'state-bridge-test',
            });
        }
        const { VoiceEnergyAppProvider } = await import('./VoiceEnergyAppProvider');
        act(() => {
            tree = renderer.create(
                <VoiceEnergyAppProvider>
                    <EnergyProbe />
                </VoiceEnergyAppProvider>,
            );
        });
        expect(observed.energy).not.toBeNull();
        return {
            luminosity: observed.energy!.luminosity.get(),
            energized: observed.energy!.sourceActive.get() > 0,
        };
    }

    const base: VoiceSessionSnapshot = {
        adapterId: 'happier.voice.openai/realtime-openai',
        sessionId: 'voice-attempt',
        status: 'connected',
        mode: 'idle',
        canStop: true,
    };

    const states: readonly Readonly<{
        name: string;
        surfaceState: VoiceSurfaceState;
        snapshot: VoiceSessionSnapshot;
        expected: VoiceEnergyState;
    }>[] = [
        {
            name: 'idle',
            surfaceState: 'idle',
            snapshot: { ...base, status: 'disconnected', mode: 'idle', canStop: false },
            expected: { luminosity: 0.18, energized: false, direction: 'none' },
        },
        {
            name: 'connecting',
            surfaceState: 'connecting',
            snapshot: { ...base, status: 'connecting', mode: 'idle' },
            expected: { luminosity: 0.4, energized: false, direction: 'orbit' },
        },
        {
            // `acquiring_mic` is intentionally represented by this same canonical snapshot shape.
            name: 'acquiring the microphone',
            surfaceState: 'connecting',
            snapshot: { ...base, status: 'connecting', mode: 'idle' },
            expected: { luminosity: 0.4, energized: false, direction: 'orbit' },
        },
        {
            name: 'listening for user input',
            surfaceState: 'listening',
            snapshot: { ...base, mode: 'listening' },
            expected: { luminosity: 0.55, energized: true, direction: 'inward' },
        },
        {
            name: 'transcribing user input',
            surfaceState: 'transcribing',
            snapshot: { ...base, mode: 'transcribing' },
            expected: { luminosity: 0.5, energized: false, direction: 'inward' },
        },
        {
            name: 'delegated thinking',
            surfaceState: 'thinking',
            snapshot: { ...base, mode: 'thinking' },
            expected: { luminosity: 0.62, energized: false, direction: 'orbit' },
        },
        {
            name: 'speaking',
            surfaceState: 'speaking',
            snapshot: { ...base, mode: 'speaking' },
            expected: { luminosity: 0.92, energized: true, direction: 'outward' },
        },
        {
            name: 'interrupted user input',
            surfaceState: 'interrupted',
            snapshot: { ...base, mode: 'listening', presentationState: 'interrupted' },
            expected: { luminosity: 0.5, energized: true, direction: 'inward' },
        },
        {
            name: 'reconnecting',
            surfaceState: 'reconnecting',
            snapshot: { ...base, presentationState: 'reconnecting' },
            expected: { luminosity: 0.38, energized: false, direction: 'unsettled' },
        },
        {
            name: 'microphone permission recovery',
            surfaceState: 'permission_required',
            snapshot: { ...base, status: 'error', errorPresentation: 'permission_required' },
            expected: { luminosity: 0.55, energized: false, direction: 'hold' },
        },
        {
            name: 'error',
            surfaceState: 'error',
            snapshot: { ...base, status: 'error', errorPresentation: 'error' },
            expected: { luminosity: 0.3, energized: false, direction: 'none' },
        },
    ];

    it.each(states)('projects $name through the canonical surface state', async ({ snapshot, expected }) => {
        await expect(project(snapshot)).resolves.toMatchObject({
            luminosity: expected.luminosity,
            energized: expected.energized,
        });
    });

    it.each(states)(
        'defines the complete $name direction and resting token at the canonical energy projection',
        ({ surfaceState, expected }) => {
            expect(resolveVoiceEnergyState(surfaceState)).toEqual(expected);
        },
    );

    it('does not turn an open input source into a semantic energized state', async () => {
        const snapshot = { ...base, mode: 'idle' as const };

        await expect(project(snapshot, true)).resolves.toMatchObject({
            luminosity: 0.18,
            energized: false,
        });
    });
});
