import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { startGitSmartHttpFixture } from './gitSmartHttpFixture';

const execute = promisify(execFile);

it('requires the fixture credential and preserves binary Git clone and push traffic on a selected branch', async () => {
    const authorization = 'Basic fixture-private-credential';
    const fixture = await startGitSmartHttpFixture({ authorization, branch: 'feature/selected' });
    const git = async (cwd: string, args: string[]) => (await execute('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
        },
    })).stdout.trim();
    try {
        for (const authorizationHeader of [undefined, 'Basic wrong']) {
            const headers: Record<string, string> = authorizationHeader ? { Authorization: authorizationHeader } : {};
            const response = await fetch(`${fixture.url}/info/refs?service=git-upload-pack`, { headers });
            expect(response.status).toBe(401);
            await response.arrayBuffer();
        }
        const checkout = join(fixture.rootDirectory, 'checkout');
        await git(fixture.rootDirectory, ['clone', '--branch', fixture.branch, fixture.url, checkout]);
        expect(await git(checkout, ['branch', '--show-current'])).toBe(fixture.branch);
        expect(await readFile(join(checkout, 'binary.bin'))).toEqual(await readFile(join(fixture.sourceRepositoryPath, 'binary.bin')));

        const pushed = Buffer.from([0, 255, 128, 13, 10, 0, 254]);
        await writeFile(join(checkout, 'binary.bin'), pushed);
        await git(checkout, ['add', 'binary.bin']);
        await git(checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'binary push']);
        await git(checkout, ['push', 'origin', `HEAD:refs/heads/${fixture.branch}`]);
        expect(await git(fixture.bareRepositoryPath, ['rev-parse', `refs/heads/${fixture.branch}`])).toBe(await git(checkout, ['rev-parse', 'HEAD']));
        expect((await execute('git', ['show', `${fixture.branch}:binary.bin`], { cwd: fixture.bareRepositoryPath, encoding: 'buffer' })).stdout).toEqual(pushed);
        expect(fixture.requests).toEqual(expect.arrayContaining([
            { method: 'GET', path: '/repository.git/info/refs', status: 401 },
            { method: 'POST', path: '/repository.git/git-upload-pack', status: 200 },
            { method: 'POST', path: '/repository.git/git-receive-pack', status: 200 },
        ]));
        expect(JSON.stringify(fixture.requests)).not.toContain(authorization);
    } finally {
        await fixture.close();
    }
});
