import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createProjectSetupSuccessStore } from './projectSetupSuccess';

describe('target-local completed project setup', () => {
    const directories: string[] = [];
    afterEach(async () => {
        await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });
    const target = { serverId: 'home', machineId: 'machine-a', workspaceRefId: 'workspace' };
    const success = {
        v: 1 as const, workspaceRefId: target.workspaceRefId, cwd: '/repo',
        platform: { os: 'linux', arch: 'x64' }, reviewedEffectDigest: 'effect',
        setupInputsDigest: 'inputs', environmentBindingReferences: ['binding@1'], completedAtMs: 123,
    };
    async function store() {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-project-setup-'));
        directories.push(homeDir);
        return { homeDir, owner: createProjectSetupSuccessStore({ homeDir }) };
    }

    it('persists only completed setup and binds success to exact target and current inputs across restart', async () => {
        const { homeDir, owner } = await store();
        expect(await owner.read(target)).toBeNull();
        await owner.recordCompletion(target, success);
        const restarted = createProjectSetupSuccessStore({ homeDir });
        expect(await restarted.read(target)).toEqual(success);
        expect(await restarted.matches(target, success)).toBe(true);
        expect(await restarted.matches(target, { ...success, setupInputsDigest: 'changed' })).toBe(false);
        expect(await restarted.matches(target, { ...success, cwd: '/other-repo' })).toBe(false);
        expect(await restarted.read({ ...target, machineId: 'machine-b' })).toBeNull();
        expect(await restarted.matches(target, { ...success, environmentBindingReferences: ['binding@2'] })).toBe(false);
        await restarted.invalidate(target);
        expect(await owner.read(target)).toBeNull();
    });

    it('drops stored extras recursively and writes only canonical completed facts', async () => {
        const { owner } = await store();
        await owner.recordCompletion(target, success);
        const path = owner.pathFor(target);
        await writeFile(path, JSON.stringify({ ...success, future: true, platform: { ...success.platform, future: true } }));
        const opened = await owner.read(target);
        expect(opened).toEqual(success);
        await owner.recordCompletion(target, opened!);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(success);
    });

    it('fails closed on invalid or transplanted stored records instead of reporting unprepared', async () => {
        const { owner } = await store();
        await owner.recordCompletion(target, success);
        await writeFile(owner.pathFor(target), JSON.stringify({ ...success, workspaceRefId: 'other-workspace' }));
        await expect(owner.read(target)).rejects.toMatchObject({ code: 'project_setup_success_unavailable' });
        await writeFile(owner.pathFor(target), '{invalid');
        await expect(owner.read(target)).rejects.toMatchObject({ code: 'project_setup_success_unavailable' });
    });
});
