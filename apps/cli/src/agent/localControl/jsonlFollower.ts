import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const JSONL_READ_CHUNK_BYTES = 64 * 1024;

export class JsonlFollower {
    private readonly filePath: string;
    private readonly pollIntervalMs: number;
    private readonly startAtEnd: boolean;
    private readonly onJson: (value: unknown) => void;
    private readonly onError?: (error: unknown) => void;

    private offsetBytes = 0;
    private buffer = '';
    private timer: NodeJS.Timeout | null = null;
    private startPromise: Promise<void> | null = null;
    private inFlight: Promise<void> | null = null;
    private stopped = false;
    private decoder = new StringDecoder('utf8');

    constructor(opts: {
        filePath: string;
        pollIntervalMs: number;
        startAtEnd?: boolean;
        onJson: (value: unknown) => void;
        onError?: (error: unknown) => void;
    }) {
        this.filePath = opts.filePath;
        this.pollIntervalMs = opts.pollIntervalMs;
        this.startAtEnd = Boolean(opts.startAtEnd);
        this.onJson = opts.onJson;
        this.onError = opts.onError;
    }

    async start(): Promise<void> {
        if (this.timer) return;
        if (this.startPromise) {
            await this.startPromise;
            return;
        }
        this.startPromise = (async () => {
            this.stopped = false;
            if (this.startAtEnd) {
                try {
                    const s = await stat(this.filePath);
                    this.offsetBytes = s.size;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
                    // Ignore missing file; writers may create it later.
                    if (code !== 'ENOENT') {
                        throw error;
                    }
                }
            }
            await this.drain();
            if (this.stopped || this.timer) return;
            this.timer = setInterval(() => {
                void this.drain();
            }, this.pollIntervalMs);
        })().finally(() => {
            this.startPromise = null;
        });
        await this.startPromise;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.inFlight) {
            await this.inFlight.catch(() => undefined);
            this.inFlight = null;
        }
    }

    private async drain(): Promise<void> {
        if (this.stopped) return;
        if (this.inFlight) return;

        const work = this.drainInner().finally(() => {
            this.inFlight = null;
        });
        this.inFlight = work;
        await work;
    }

    private async drainInner(): Promise<void> {
        let size = 0;
        try {
            const s = await stat(this.filePath);
            size = s.size;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException | null | undefined)?.code;
            // Missing file is not fatal (writers can create it later).
            if (code !== 'ENOENT') {
                this.onError?.(e);
            }
            return;
        }

        // File truncated / rotated.
        if (size < this.offsetBytes) {
            this.offsetBytes = 0;
            this.buffer = '';
            this.decoder = new StringDecoder('utf8');
        }

        const toRead = size - this.offsetBytes;
        if (toRead <= 0) return;

        try {
            const fh = await open(this.filePath, 'r');
            try {
                let position = this.offsetBytes;
                let remaining = toRead;
                const chunkBuffer = Buffer.allocUnsafe(Math.min(JSONL_READ_CHUNK_BYTES, remaining));

                while (remaining > 0) {
                    const bytesToRead = Math.min(chunkBuffer.byteLength, remaining);
                    const res = await fh.read(chunkBuffer, 0, bytesToRead, position);
                    if (res.bytesRead <= 0) break;
                    position += res.bytesRead;
                    remaining -= res.bytesRead;
                    this.buffer += this.decoder.write(chunkBuffer.subarray(0, res.bytesRead));
                }
                this.offsetBytes = position;
            } finally {
                await fh.close();
            }
        } catch (e) {
            this.onError?.(e);
            return;
        }

        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                this.onJson(parsed);
            } catch (e) {
                this.onError?.(e);
            }
        }
    }
}
