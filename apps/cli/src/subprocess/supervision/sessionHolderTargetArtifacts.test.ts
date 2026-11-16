import { afterEach, describe, expect, it, vi } from 'vitest';

// Published files and the controller OS/CPU are genuine deployment boundaries.
vi.mock('node:fs', async original => {
    const actual = await original<typeof import('node:fs')>();
    return { ...actual, existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) =>
        String(path).includes('happier-session-holder.') || String(path).endsWith('/happier-process-custody') || actual.existsSync(path)) };
});
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
        const path = String(args[0]);
        return path.includes('happier-session-holder.') || path.endsWith('/happier-process-custody')
            ? Promise.resolve(Buffer.from(path)) : actual.readFile(...args);
    }) };
});

import { readSessionTargetHolderArtifacts } from './sessionHolderTargetArtifacts';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    Object.defineProperty(process, 'arch', originalArch);
});

describe('published Session target artifacts', () => {
    it('places the published Darwin holder and the matching controller custody helper in a Darwin guest', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });
        const artifacts = await readSessionTargetHolderArtifacts({ os: 'darwin', arch: 'arm64', home: '/Users/guest' });
        expect(Buffer.from(artifacts.holder.bytes).toString()).toMatch(/happier-session-holder\.darwin-arm64$/u);
        expect(Buffer.from(artifacts.helper.bytes).toString()).toMatch(/tools\/unpacked\/happier-process-custody$/u);
        expect(artifacts.holder.sha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('does not send a foreign controller helper to a Darwin guest', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });
        await expect(readSessionTargetHolderArtifacts({ os: 'darwin', arch: 'arm64', home: '/Users/guest' }))
            .rejects.toMatchObject({ code: 'session_holder_unavailable' });
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        Object.defineProperty(process, 'arch', { value: 'x64' });
        await expect(readSessionTargetHolderArtifacts({ os: 'darwin', arch: 'arm64', home: '/Users/guest' }))
            .rejects.toMatchObject({ code: 'session_holder_unavailable' });
    });
});
