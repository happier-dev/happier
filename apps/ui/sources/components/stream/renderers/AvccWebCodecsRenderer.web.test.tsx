import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

function avccEnvelope(tag: number, payload: readonly number[]): Uint8Array {
    const length = payload.length + 1;
    const bytes = new Uint8Array(4 + length);
    new DataView(bytes.buffer).setUint32(0, length, false);
    bytes[4] = tag;
    bytes.set(payload, 5);
    return bytes;
}

function jpegBytes(seed: number): Uint8Array {
    return new Uint8Array([0xff, 0xd8, seed, 0xff, 0xd9]);
}

describe('AvccWebCodecsRenderer web', () => {
    it('routes AVCC description, seed, keyframe, delta, and reconfiguration through a sanitized adapter boundary', async () => {
        const mod = await import('./AvccWebCodecsRenderer.web').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('AvccWebCodecsRenderer');
        if (!('AvccWebCodecsRenderer' in mod)) return;

        const calls: string[] = [];
        const reconfigured: unknown[] = [];
        const adapter = {
            isSupported: () => ({ ok: true as const }),
            configure: vi.fn(async (input: { description: Uint8Array }) => {
                calls.push(`configure:${[...input.description].join('.')}`);
                return input.description[3] === 0x2a
                    ? { width: 390, height: 844, orientation: 'portrait' as const }
                    : { width: 844, height: 390, orientation: 'landscapeLeft' as const };
            }),
            decode: vi.fn(async (input: { type: 'keyframe' | 'delta'; payload: Uint8Array }) => {
                calls.push(`decode:${input.type}:${[...input.payload].join('.')}`);
            }),
            close: vi.fn(() => {
                calls.push('close');
            }),
        };

        const screen = await renderScreen(
            <mod.AvccWebCodecsRenderer
                adapter={adapter}
                chunks={[
                    avccEnvelope(0x01, [1, 0x64, 0, 0x28]),
                    avccEnvelope(0x04, [...jpegBytes(7)]),
                    avccEnvelope(0x02, [0x65, 1]),
                    avccEnvelope(0x03, [0x41, 2]),
                    avccEnvelope(0x01, [1, 0x64, 0, 0x2a]),
                    avccEnvelope(0x02, [0x65, 3]),
                ]}
                maxBufferedBytes={256}
                onReconfigured={(event) => reconfigured.push(event)}
                testID="avcc"
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('avcc-webcodecs-surface')).toBeTruthy();
        expect(screen.findByTestId('avcc-seed-frame')?.props.source).toEqual({
            uri: 'data:image/jpeg;base64,/9gH/9k=',
        });
        expect(calls).toEqual([
            'configure:1.100.0.40',
            'decode:keyframe:101.1',
            'decode:delta:65.2',
            'configure:1.100.0.42',
            'decode:keyframe:101.3',
        ]);
        expect(reconfigured).toEqual([
            { type: 'decoderReconfigured', width: 844, height: 390, orientation: 'landscapeLeft' },
            { type: 'decoderReconfigured', width: 390, height: 844, orientation: 'portrait' },
        ]);
    });

    it('fails closed with an unsupported diagnostic instead of trying to decode', async () => {
        const mod = await import('./AvccWebCodecsRenderer.web').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('AvccWebCodecsRenderer');
        if (!('AvccWebCodecsRenderer' in mod)) return;

        const diagnostics: unknown[] = [];
        const adapter = {
            isSupported: () => ({ ok: false as const, reasonCode: 'webcodecs_unavailable' as const }),
            configure: vi.fn(),
            decode: vi.fn(),
            close: vi.fn(),
        };

        await renderScreen(
            <mod.AvccWebCodecsRenderer
                adapter={adapter}
                chunks={[avccEnvelope(0x01, [1, 0x64, 0, 0x28])]}
                onDiagnostic={(diagnostic) => diagnostics.push(diagnostic)}
                testID="avcc"
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(diagnostics).toEqual([{ reasonCode: 'webcodecs_unavailable' }]);
        expect(adapter.configure).not.toHaveBeenCalled();
        expect(adapter.decode).not.toHaveBeenCalled();
    });

    it('emits startup timeout when decode is enqueued but no output frame arrives', async () => {
        const mod = await import('./AvccWebCodecsRenderer.web').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('AvccWebCodecsRenderer');
        if (!('AvccWebCodecsRenderer' in mod)) return;

        const diagnostics: unknown[] = [];
        const adapter = {
            isSupported: () => ({ ok: true as const }),
            configure: vi.fn(async () => ({})),
            decode: vi.fn(() => new Promise<void>(() => undefined)),
            close: vi.fn(),
        };

        await renderScreen(
            <mod.AvccWebCodecsRenderer
                adapter={adapter}
                chunks={[
                    avccEnvelope(0x01, [1, 0x64, 0, 0x28]),
                    avccEnvelope(0x02, [0x65, 1]),
                ]}
                onDiagnostic={(diagnostic) => diagnostics.push(diagnostic)}
                onStartupTimeout={(diagnostic) => diagnostics.push({ startup: diagnostic })}
                startupTimeoutMs={1}
                testID="avcc"
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(diagnostics).toContainEqual({ reasonCode: 'decoder_startup_timeout' });
        expect(diagnostics).toContainEqual({ startup: { reasonCode: 'decoder_startup_timeout' } });
    });
});
