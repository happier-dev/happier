import { open } from 'node:fs/promises';
import type { ManagedGuestCliBuildTargetV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

export type ExecutablePlatform = Readonly<ManagedGuestCliBuildTargetV1>;

/** Shared native payload interpretation for first-party and Agent target placement. */
export async function readExecutablePlatform(path: string): Promise<ExecutablePlatform | 'script' | null> {
    const file = await open(path, 'r');
    let header: Buffer;
    try {
        const bytes = Buffer.alloc(20);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        header = bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
    if (header.subarray(0, 2).toString() === '#!') return 'script';
    if (header.length !== 20) return null;
    if (header.readUInt32BE(0) === 0x7f454c46 && header[4] === 2 && header[5] === 1) {
        const machine = header.readUInt16LE(18);
        return machine === 62 ? { os: 'linux', arch: 'x64' } : machine === 183 ? { os: 'linux', arch: 'arm64' } : null;
    }
    if (header.readUInt32LE(0) === 0xfeedfacf) {
        const cpu = header.readUInt32LE(4);
        return cpu === 0x01000007 ? { os: 'darwin', arch: 'x64' } : cpu === 0x0100000c ? { os: 'darwin', arch: 'arm64' } : null;
    }
    return null;
}
