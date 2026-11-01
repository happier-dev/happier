import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan,
    type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend,
    type MachineSetupNativeCommand } from './nativeBackend.js';
import { createCloudflareConnectorRemovalSteps, createCloudflareConnectorSetupSteps } from './nativeCloudflare.js';

// The existing nativeBackend.test.ts root fixture owns this OS-boundary shape.
// Real filesystem bytes/inodes/modes and the real P20 owner stay beneath it.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const input = { tunnelId: '12345678-1234-4234-8234-123456789abc', grantRef: 'opaque-subject-connector-grant' };
const basis = { kind: 'bootstrap', managedId: 'cloudflare-private-retirement', operationId: 'reviewed-retirement', admittedInputDigest: 'a'.repeat(64) } as const;

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-cf-retirement-')); roots.push(root);
    const path = join(root, 'token');
    const originalLstat = filesystem.lstat;
    const ownership = new Map<string, { uid: number; gid: number }>();
    const ancestors = new Set<string>();
    for (let parent = root; ; parent = dirname(parent)) {
        ancestors.add(parent); if (dirname(parent) === parent) break;
    }
    vi.spyOn(filesystem, 'lstat').mockImplementation(async (name, options) => {
        const stat = await originalLstat(name, options), value = String(name);
        const ancestor = ancestors.has(value), inside = value.startsWith(root + sep);
        const owner = ownership.get(stat.ino.toString()) ?? (ancestor || inside && stat.isDirectory() ? { uid: 0, gid: 0 } : undefined);
        const mode = ancestor ? Number(stat.mode) & ~0o022 : Number(stat.mode);
        return Object.assign(stat, { ...(owner ? { uid: typeof stat.uid === 'bigint' ? BigInt(owner.uid) : owner.uid,
            gid: typeof stat.gid === 'bigint' ? BigInt(owner.gid) : owner.gid } : {}), mode: typeof stat.mode === 'bigint' ? BigInt(mode) : mode });
    });
    vi.spyOn(filesystem, 'chown').mockImplementation(async (name, uid, gid) => {
        ownership.set((await originalLstat(name)).ino.toString(), { uid, gid });
    });
    const materialized: Uint8Array[] = [];
    const secret = 'cloudflare-test-token-kept-private';
    const backend = createMachineSetupNativeBackend({
        run: async (command: MachineSetupNativeCommand) => {
            if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
            throw new Error(`Unexpected native command ${command.executable}`);
        },
        async materializeSecretGrant(grantRef) {
            expect(grantRef).toBe(input.grantRef);
            const bytes = Buffer.from(secret); materialized.push(bytes);
            return { bytes, async assertCurrent() {}, dispose() { bytes.fill(0); } };
        },
    });
    // Substitute only the OS location, never the authored state/content/owner.
    const localFiles = (steps: MachineRecipeStepV1[]) => steps.flatMap(step => step.kind === 'file' ? [{ ...step, path }] : []);
    return { root, path, backend, materialized, secret, localFiles };
}

it('authors exact private absence for this connector without a digest or directory removal', () => {
    expect(createCloudflareConnectorRemovalSteps(input)).toEqual([
        { id: 'cloudflare-connector-token', kind: 'file', state: 'absent',
            path: `/etc/cloudflared/happier-${input.tunnelId}.token`, owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'secretGrant', grantRef: input.grantRef } },
    ]);
});

it.each(['match', 'mismatch', 'missing'] as const)('removes only the privately matched Cloudflare token through P20 (%s)', async scenario => {
    const f = await fixture();
    const other = join(f.root, 'shared-other-tunnel.token');
    await writeFile(other, 'shared-connector-must-stay', { mode: 0o600 });
    if (scenario !== 'missing') {
        const setup = await checkMachineSetupEffectPlan({ basis, backend: f.backend, steps: f.localFiles(createCloudflareConnectorSetupSteps(input)) });
        expect((await applyMachineSetupEffectPlan({ plan: setup, backend: f.backend })).status).toBe('applied');
        if (scenario === 'mismatch') await writeFile(f.path, 'foreign-file-must-stay');
    }
    const removal = await checkMachineSetupEffectPlan({ basis, backend: f.backend, steps: f.localFiles(createCloudflareConnectorRemovalSteps(input)) });
    const result = await applyMachineSetupEffectPlan({ plan: removal, backend: f.backend });
    expect(result.status).toBe(scenario === 'mismatch' ? 'unavailable' : 'applied');
    if (scenario === 'mismatch') expect(await readFile(f.path, 'utf8')).toBe('foreign-file-must-stay');
    else await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(other, 'utf8')).toBe('shared-connector-must-stay');
    expect(JSON.stringify({ removal, result })).not.toContain(f.secret);
    expect(removal.steps.every(step => !('contentDigest' in step))).toBe(true);
    expect(f.materialized.length).toBeGreaterThan(0);
    expect(f.materialized.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
});
