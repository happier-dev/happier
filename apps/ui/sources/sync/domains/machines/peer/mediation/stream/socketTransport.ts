import { MachineLiveStreamDecodedEnvelopeV1Schema, MachineLiveStreamRelayEnvelopeV1Schema, type MachineLiveStreamRelayEnvelopeV1, type MachineLiveStreamWireEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { MachineLiveStreamPayloadErrorV1, hasMachineLiveStreamSensitiveContentV1, openMachineLiveStreamEnvelopeV1, sealMachineLiveStreamEnvelopeV1, type MachineLiveStreamContentV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

/** One framing owner for active and explicitly scoped viewer sockets. No keys live here. */
export function createMachineLiveStreamSocketTransport(input: Readonly<{
    emit: (wire: MachineLiveStreamWireEnvelopeV1) => void;
    deliver: (decoded: MachineLiveStreamRelayEnvelopeV1) => void;
    resolveContent: (sourceMachineId: string) => Promise<MachineLiveStreamContentV1>;
    isCurrent: () => boolean;
    onError: (error: MachineLiveStreamPayloadErrorV1) => void;
}>) {
    let receiving: Promise<void> | null = null;
    let sending: Promise<void> | null = null;
    function reject(error: unknown, envelope?: MachineLiveStreamWireEnvelopeV1 | MachineLiveStreamRelayEnvelopeV1) {
        if (!input.isCurrent()) return;
        const typed = error instanceof MachineLiveStreamPayloadErrorV1
            ? error : new MachineLiveStreamPayloadErrorV1('stream_encryption_mode_unavailable');
        input.onError(typed);
        const message = envelope?.message;
        if (!envelope || !message || (message.kind !== 'frame' && message.kind !== 'sideband_control')) return;
        const stopped = { ...envelope, message: { kind: 'control' as const, control: {
            v: 1 as const, streamId: message.kind === 'frame' ? message.frame.streamId : message.control.streamId,
            kind: 'stop' as const, reasonCode: typed.code,
        } } } satisfies MachineLiveStreamRelayEnvelopeV1;
        input.emit(stopped);
        input.deliver(stopped);
    }
    function send(raw: MachineLiveStreamRelayEnvelopeV1): void {
        const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse(raw);
        if (!parsed.success) { reject(new MachineLiveStreamPayloadErrorV1('stream_payload_invalid')); return; }
        if (!sending && !hasMachineLiveStreamSensitiveContentV1(parsed.data)) {
            if (input.isCurrent()) input.emit(MachineLiveStreamRelayEnvelopeV1Schema.parse(parsed.data));
            return;
        }
        const task = (sending ?? Promise.resolve()).then(async () => {
            if (!input.isCurrent()) return;
            const content = hasMachineLiveStreamSensitiveContentV1(parsed.data)
                ? await input.resolveContent(parsed.data.sourceMachineId) : { mode: 'plain' as const };
            const sealed = await sealMachineLiveStreamEnvelopeV1(parsed.data, content);
            if (!sealed.ok) throw new MachineLiveStreamPayloadErrorV1(sealed.code);
            if (input.isCurrent()) input.emit(sealed.value);
        }).catch((error: unknown) => reject(error, parsed.data));
        sending = task;
        void task.then(() => { if (sending === task) sending = null; });
    }
    function receive(raw: unknown): void {
        const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(raw);
        if (!parsed.success) { reject(new MachineLiveStreamPayloadErrorV1('stream_payload_invalid')); return; }
        if (!receiving && !hasMachineLiveStreamSensitiveContentV1(parsed.data)) {
            if (input.isCurrent()) input.deliver(MachineLiveStreamDecodedEnvelopeV1Schema.parse(parsed.data));
            return;
        }
        const task = (receiving ?? Promise.resolve()).then(async () => {
            if (!input.isCurrent()) return;
            const content = hasMachineLiveStreamSensitiveContentV1(parsed.data)
                ? await input.resolveContent(parsed.data.sourceMachineId) : { mode: 'plain' as const };
            const opened = await openMachineLiveStreamEnvelopeV1(parsed.data, content);
            if (!opened.ok) throw new MachineLiveStreamPayloadErrorV1(opened.code);
            if (input.isCurrent()) input.deliver(opened.value);
        }).catch((error: unknown) => reject(error, parsed.data));
        receiving = task;
        void task.then(() => { if (receiving === task) receiving = null; });
    }
    return { send, receive };
}
