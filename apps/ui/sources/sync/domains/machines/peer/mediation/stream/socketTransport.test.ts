import { describe, expect, it, vi } from 'vitest';
import { sealMachineLiveStreamEnvelopeV1} from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { type MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { MachineEncryption } from '@/sync/encryption/machineEncryption';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { createMachineLiveStreamSocketTransport } from './socketTransport';

const frame: MachineLiveStreamRelayEnvelopeV1 = {
    v: 1, sourceMachineId: 'source', targetMachineId: 'source', viewerSocketId: 'tab',
    message: { kind: 'frame', frame: { v: 1, streamId: 'stream', sequence: 1, timestampMs: 1000,
        payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3 } },
};
function cipher(keyByte: number) {
    return new MachineEncryption('source', new AES256Encryption(new Uint8Array(32).fill(keyByte)), new EncryptionCache());
}
describe('live-stream viewer transport', () => {
    it('opens pixels with the real Machine cipher and seals input before network emission', async () => {
        const machine = cipher(7);
        const content = { mode: 'e2ee' as const, cipher: machine };
        const emit = vi.fn(); const deliver = vi.fn(); const onError = vi.fn();
        const transport = createMachineLiveStreamSocketTransport({ emit, deliver, onError,
            resolveContent: async () => content, isCurrent: () => true });
        const sealed = await sealMachineLiveStreamEnvelopeV1(frame, content);
        if (!sealed.ok) throw new Error(sealed.code);
        transport.receive(sealed.value);
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(frame));
        const input: MachineLiveStreamRelayEnvelopeV1 = { ...frame, message: { kind: 'sideband_control', control: {
            v: 1, streamId: 'stream', sourceId: 'view', eventId: 'event', kind: 'keyboard_text', text: 'private input',
        } } };
        transport.send(input);
        await vi.waitFor(() => expect(emit).toHaveBeenCalled());
        expect(emit.mock.calls[0]?.[0].message.control.payload.t).toBe('encrypted');
        expect(JSON.stringify(emit.mock.calls)).not.toContain('private input');
        expect(onError).not.toHaveBeenCalled();
    });

    it('wrong-key pixels yield a typed terminal stop, never a decoded frame', async () => {
        const sealed = await sealMachineLiveStreamEnvelopeV1(frame, { mode: 'e2ee', cipher: cipher(7) });
        if (!sealed.ok) throw new Error(sealed.code);
        const emit = vi.fn(); const deliver = vi.fn(); const onError = vi.fn();
        const transport = createMachineLiveStreamSocketTransport({ emit, deliver, onError,
            resolveContent: async () => ({ mode: 'e2ee', cipher: cipher(8) }), isCurrent: () => true });
        transport.receive(sealed.value);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'stream_payload_authentication_failed' })));
        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ message: { kind: 'control', control: {
            v: 1, streamId: 'stream', kind: 'stop', reasonCode: 'stream_payload_authentication_failed',
        } } }));
        expect(deliver.mock.calls.some(([value]) => value.message.kind === 'frame')).toBe(false);
    });

    it.each(['transport', 'content'] as const)('drops an in-flight decode when its %s is retired', async owner => {
        const sealed = await sealMachineLiveStreamEnvelopeV1(frame, { mode: 'plain' });
        if (!sealed.ok) throw new Error(sealed.code);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let current = true;
        const deliver = vi.fn(); const emit = vi.fn();
        const transport = createMachineLiveStreamSocketTransport({ emit, deliver, onError: vi.fn(),
            isCurrent: () => owner === 'content' || current,
            resolveContent: async () => { await pending; return { mode: 'plain', isCurrent: () => current }; } });
        transport.receive(sealed.value);
        await Promise.resolve(); current = false; release();
        await pending; await new Promise<void>(resolve => setImmediate(resolve));
        expect(deliver).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    });

    it('does not send a late accepted stream cleanup after its Account transport retires', () => {
        let current = true;
        const emit = vi.fn();
        const transport = createMachineLiveStreamSocketTransport({ emit, deliver: vi.fn(), onError: vi.fn(),
            resolveContent: async () => ({ mode: 'plain' }), isCurrent: () => current });
        const stop: MachineLiveStreamRelayEnvelopeV1 = { ...frame, message: { kind: 'control', control: {
            v: 1, streamId: 'stream', kind: 'stop', reasonCode: 'viewer_closed',
        } } };
        transport.send(stop);
        expect(emit).toHaveBeenCalledWith(stop);
        emit.mockClear();
        current = false;
        transport.send(stop);
        expect(emit).not.toHaveBeenCalled();
    });
});
