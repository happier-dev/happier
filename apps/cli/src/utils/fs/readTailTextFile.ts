import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export async function readTailTextFile(params: Readonly<{ path: string; maxBytes: number }>): Promise<string> {
    const filePath = String(params.path ?? '').trim();
    if (!filePath) return '';

    const boundedMaxBytes = Number.isFinite(params.maxBytes) ? Math.max(1, Math.trunc(params.maxBytes)) : 1;
    const handle = await open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const size = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
        if (size === 0) return '';

        const start = Math.max(0, size - boundedMaxBytes);
        const length = size - start;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, start);

        // Decode with a StringDecoder so truncated multibyte sequences at the boundary
        // do not throw and do not corrupt subsequent characters.
        const decoder = new StringDecoder('utf8');
        return decoder.write(buf);
    } finally {
        await handle.close();
    }
}

