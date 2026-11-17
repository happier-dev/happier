import { PROVIDER_REDACTION_REPLACEMENT, type ProviderRedactionLease } from '@/providers/spawn/redaction';

type Stream = 'stdout' | 'stderr';
type Projection = 'stream' | 'combined';
type Span = { length: number; redacted: boolean };
type ProcessOutputRedaction = Readonly<{
    push: (stream: Stream, data: Uint8Array) => void;
    flush: (stream: Stream) => void;
}>;
type Queue<T> = { items: T[]; head: number };
const queue = <T>(): Queue<T> => ({ items: [], head: 0 });
function front<T>(value: Queue<T>): T | undefined { return value.items[value.head]; }
function shift<T>(value: Queue<T>): void {
    value.head++;
    if (value.head === value.items.length) { value.items = []; value.head = 0; }
}
type Chunk = {
    stream: Stream; data: Uint8Array; length: number; retainedStart: number; emitted: number;
    consumed: Record<Projection, number>;
    decisions: Record<Projection, Queue<Span>>;
};

/**
 * Mask per-pipe and raw-arrival matches, then protect final merged order.
 * Each matcher retains only an unresolved secret prefix. For a longest value
 * of L bytes, pending raw/candidate bytes total at most 4 * (L - 1) when L > 0. Completed
 * output on the other channel progresses without retaining its original data.
 */
export function createProcessOutputRedaction(
    lease: ProviderRedactionLease,
    emit: (stream: Stream, bytes: Uint8Array) => void,
): ProcessOutputRedaction {
    const pending = { stdout: queue<Chunk>(), stderr: queue<Chunk>(), combined: queue<Chunk>() };
    const masked = { stdout: false, stderr: false };
    const deliveries: { stream: Stream; chunks: Uint8Array[]; length: number }[] = [];
    const enqueue = (stream: Stream, data: Uint8Array) => {
        if (!data.byteLength) return;
        const previous = deliveries.at(-1);
        if (previous?.stream === stream) { previous.chunks.push(data); previous.length += data.byteLength; }
        else deliveries.push({ stream, chunks: [data], length: data.byteLength });
    };
    const publish = () => {
        for (const delivery of deliveries) {
            emit(delivery.stream, delivery.chunks.length === 1 ? delivery.chunks[0]! : Buffer.concat(delivery.chunks, delivery.length));
        }
        deliveries.length = 0;
    };
    // Per-pipe deferral can bring safe fragments together into a registered
    // value. Protect the actual emission order while retaining each byte's tag.
    type Candidate = { stream: Stream; data: Uint8Array; offset: number };
    const candidates = queue<Candidate>();
    const finalSanitizer = lease.createStreamingSanitizer((length, redacted) => {
        // Leave a marker on every affected pipe: dropping a matched part
        // without replacement can join another registered value on that pipe.
        const replacedStreams = new Set<Stream>();
        while (length) {
            const candidate = front(candidates)!;
            const take = Math.min(length, candidate.data.byteLength - candidate.offset);
            if (redacted) {
                if (!replacedStreams.has(candidate.stream)) {
                    enqueue(candidate.stream, Buffer.from(PROVIDER_REDACTION_REPLACEMENT));
                    replacedStreams.add(candidate.stream);
                }
            } else {
                enqueue(candidate.stream, candidate.data.subarray(candidate.offset, candidate.offset + take));
            }
            candidate.offset += take;
            if (candidate.offset === candidate.data.byteLength) shift(candidates);
            length -= take;
        }
    });
    const redactFinal = (stream: Stream, bytes: Uint8Array) => {
        candidates.items.push({ stream, data: bytes, offset: 0 });
        finalSanitizer.pushBytes(bytes);
    };
    const ended = new Set<Stream>();
    const touched = new Set<Chunk>();
    const flushReady = (chunk: Chunk) => {
        let own: Span | undefined;
        let combined: Span | undefined;
        while ((own = front(chunk.decisions.stream)) && (combined = front(chunk.decisions.combined))) {
            const length = Math.min(own.length, combined.length);
            if (own.redacted || combined.redacted) {
                if (!masked[chunk.stream]) redactFinal(chunk.stream, Buffer.from(PROVIDER_REDACTION_REPLACEMENT));
                masked[chunk.stream] = true;
            } else {
                redactFinal(chunk.stream, chunk.data.subarray(chunk.emitted - chunk.retainedStart, chunk.emitted - chunk.retainedStart + length));
                masked[chunk.stream] = false;
            }
            chunk.emitted += length;
            own.length -= length;
            combined.length -= length;
            if (!own.length) shift(chunk.decisions.stream);
            if (!combined.length) shift(chunk.decisions.combined);
        }
    };
    const observe = (source: keyof typeof pending, projection: Projection) => (length: number, redacted: boolean) => {
        while (length) {
            const chunk = front(pending[source])!;
            const take = Math.min(length, chunk.length - chunk.consumed[projection]);
            chunk.decisions[projection].items.push({ length: take, redacted });
            chunk.consumed[projection] += take;
            if (chunk.consumed[projection] === chunk.length) shift(pending[source]);
            length -= take;
            flushReady(chunk);
            touched.add(chunk);
        }
    };
    const sanitizers = {
        stdout: lease.createStreamingSanitizer(observe('stdout', 'stream')),
        stderr: lease.createStreamingSanitizer(observe('stderr', 'stream')),
        combined: lease.createStreamingSanitizer(observe('combined', 'combined')),
    };
    // Snapshot the admitted values before the launch lease can close. The
    // canonical sanitizer acquires its known values lazily, even for empty input.
    Object.values(sanitizers).forEach(value => value.pushBytes(new Uint8Array()));
    finalSanitizer.pushBytes(new Uint8Array());
    const compact = () => {
        for (const chunk of touched) {
            if (chunk.emitted > chunk.retainedStart) {
                // Copy only the undecided tail: a tiny secret prefix must not pin its
                // original large pipe chunk, or hold unrelated output behind it.
                chunk.data = Uint8Array.from(chunk.data.subarray(chunk.emitted - chunk.retainedStart));
                chunk.retainedStart = chunk.emitted;
            }
            for (const value of Object.values(chunk.decisions)) {
                if (value.head) { value.items = value.items.slice(value.head); value.head = 0; }
            }
        }
        touched.clear();
        // Only a suffix may remain after the final matcher returns. Copy it so
        // neither a resolved large chunk nor an upstream tail stays retained.
        if (candidates.head) { candidates.items = candidates.items.slice(candidates.head); candidates.head = 0; }
        for (const candidate of candidates.items) {
            candidate.data = Uint8Array.from(candidate.data.subarray(candidate.offset));
            candidate.offset = 0;
        }
        for (const value of Object.values(pending)) {
            if (value.head) { value.items = value.items.slice(value.head); value.head = 0; }
        }
    };
    return {
        push(stream: Stream, data: Uint8Array) {
            if (!data.byteLength) return;
            const chunk: Chunk = { stream, data, length: data.byteLength, retainedStart: 0, emitted: 0,
                consumed: { stream: 0, combined: 0 }, decisions: { stream: queue(), combined: queue() } };
            pending[stream].items.push(chunk);
            pending.combined.items.push(chunk);
            sanitizers.combined.pushBytes(data);
            sanitizers[stream].pushBytes(data);
            publish();
            compact();
        },
        flush(stream: Stream) {
            if (ended.has(stream)) return;
            ended.add(stream);
            sanitizers[stream].flushBytes();
            if (ended.size === 2) {
                sanitizers.combined.flushBytes();
                finalSanitizer.flushBytes();
            }
            publish();
            compact();
        },
    };
}
