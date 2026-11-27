// PostgreSQL's MAX_STARTUP_PACKET_LENGTH covers the version and parameters, excluding the length word.
const MAX_STARTUP_PACKET_LENGTH = 10_000;

/** PostgreSQL v3 framing. Skipped payloads (auth, result rows, COPY) are never buffered. */
export class PostgresFrames {
    private readonly header = Buffer.alloc(8);
    private headerBytes = 0;
    private remaining = 0;
    private body: Buffer | undefined;
    private bodyBytes = 0;
    private tag = '';
    private stopped = false;

    constructor(
        private startup: boolean,
        private readonly retain: (tag: string) => boolean,
        private readonly receive: (tag: string, body: Buffer) => void,
        private readonly receiveStartup: (code: number, body: Buffer) => void,
    ) {}

    disable(): void { this.stopped = true; this.body = undefined; }

    feed(bytes: Buffer): void {
        let offset = 0;
        while (!this.stopped && offset < bytes.length) {
            if (this.remaining === 0) {
                const headerLength = this.startup ? 8 : 5;
                const count = Math.min(headerLength - this.headerBytes, bytes.length - offset);
                bytes.copy(this.header, this.headerBytes, offset, offset + count);
                this.headerBytes += count; offset += count;
                if (this.headerBytes < headerLength) continue;
                this.headerBytes = 0;
                const length = this.header.readInt32BE(this.startup ? 0 : 1);
                if (length < (this.startup ? 8 : 4)) throw new Error('Invalid PostgreSQL frame length');
                this.remaining = length - (this.startup ? 8 : 4);
                if (this.startup) {
                    this.startup = false;
                    this.tag = '';
                    if (length - 4 > MAX_STARTUP_PACKET_LENGTH) throw new Error('Invalid PostgreSQL startup packet length');
                    this.body = Buffer.alloc(this.remaining);
                } else {
                    this.tag = String.fromCharCode(this.header[0]!);
                    this.body = this.retain(this.tag) ? Buffer.alloc(this.remaining) : undefined;
                }
                this.bodyBytes = 0;
                if (this.remaining === 0) this.receiveFrame();
            } else {
                const count = Math.min(this.remaining, bytes.length - offset);
                this.body?.set(bytes.subarray(offset, offset + count), this.bodyBytes);
                offset += count; this.bodyBytes += count; this.remaining -= count;
                if (this.remaining === 0) this.receiveFrame();
            }
        }
    }

    private receiveFrame(): void {
        const body = this.body ?? Buffer.alloc(0);
        this.body = undefined;
        if (this.tag) this.receive(this.tag, body);
        else this.receiveStartup(this.header.readInt32BE(4), body);
    }
}

/** Reads only explicitly selected protocol fields, never authentication or row data. */
export class WireReader {
    private offset = 0;
    constructor(private readonly bytes: Buffer) {}
    string(): string {
        const end = this.bytes.indexOf(0, this.offset);
        if (end < 0) throw new Error('Unterminated PostgreSQL string');
        const value = this.bytes.toString('utf8', this.offset, end); this.offset = end + 1; return value;
    }
    int16(): number { const value = this.bytes.readUInt16BE(this.offset); this.offset += 2; return value; }
    int32(): number { const value = this.bytes.readInt32BE(this.offset); this.offset += 4; return value; }
    value(length: number): Buffer {
        if (length < 0 || this.offset + length > this.bytes.length) throw new Error('Invalid PostgreSQL field length');
        const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value;
    }
    end(): void { if (this.offset !== this.bytes.length) throw new Error('Unexpected PostgreSQL fields'); }
}
