type NativeOutputStream = 'stdout' | 'stderr';
type NativeOutputSink = (stream: NativeOutputStream, chunk: Uint8Array) => void;

const resourcePrefixes = [Buffer.from(' Network '), Buffer.from(' Volume ')];

/** Compose 5.6.0 repeats resource progress notifications even with JSON progress.
 * Normalize those events at the native adapter, before the byte-preserving log
 * writer. State belongs to one command; diagnostics and application bytes pass
 * through unchanged, including repeated lines.
 */
export function createNativeComposeProgressOutput(append: NativeOutputSink) {
    const transitions = new Map<string, string>();
    let pending = Buffer.alloc(0);
    let passthrough = false;
    const emitLine = (line: Buffer) => {
        const event = /^ (Network|Volume) (\S+) (Creating|Created|Removing|Removed)[ \t]*(?:\r?\n)?$/u.exec(line.toString('utf8'));
        if (event) {
            const resource = `${event[1]} ${event[2]}`;
            if (transitions.get(resource) === event[3]) return;
            transitions.set(resource, event[3]);
        }
        append('stderr', line);
    };
    return {
        onChunk(stream: NativeOutputStream, chunk: Uint8Array): void {
            if (stream === 'stdout') { append(stream, chunk); return; }
            let offset = 0;
            while (offset < chunk.length) {
                const newline = chunk.indexOf(10, offset);
                const complete = newline !== -1;
                const end = complete ? newline + 1 : chunk.length;
                const part = chunk.subarray(offset, end);
                offset = end;
                if (passthrough) {
                    append(stream, part);
                    passthrough = !complete;
                    continue;
                }
                const line = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
                pending = Buffer.alloc(0);
                const candidate = resourcePrefixes.some(prefix => {
                    const length = Math.min(prefix.length, line.length);
                    return prefix.subarray(0, length).equals(line.subarray(0, length));
                });
                if (!candidate) {
                    // Do not buffer newline-free application diagnostics.
                    append(stream, line);
                    passthrough = !complete;
                } else if (complete) emitLine(line);
                else pending = line;
            }
        },
        finish(): void {
            if (pending.length) { emitLine(pending); pending = Buffer.alloc(0); }
        },
    };
}
