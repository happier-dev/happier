import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { git, initBareRemote } from './gitRepoHarness';

describe('gitRepoHarness initBareRemote', () => {
    const originalEnv = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };

    afterEach(() => {
        if (originalEnv.GIT_CONFIG_GLOBAL === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = originalEnv.GIT_CONFIG_GLOBAL;
        }

        if (originalEnv.GIT_CONFIG_SYSTEM === undefined) {
            delete process.env.GIT_CONFIG_SYSTEM;
        } else {
            process.env.GIT_CONFIG_SYSTEM = originalEnv.GIT_CONFIG_SYSTEM;
        }
    });

    it('forces HEAD to main even when git init defaultBranch is configured differently', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-ui-initbare-'));
        try {
            const configPath = join(cwd, '.gitconfig');
            writeFileSync(configPath, '[init]\n\tdefaultBranch = master\n', 'utf8');

            process.env.GIT_CONFIG_GLOBAL = configPath;
            process.env.GIT_CONFIG_SYSTEM = '/dev/null';

            initBareRemote(cwd);

            const headRef = git(cwd, ['symbolic-ref', 'HEAD']);
            expect(headRef).toBe('refs/heads/main');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});

