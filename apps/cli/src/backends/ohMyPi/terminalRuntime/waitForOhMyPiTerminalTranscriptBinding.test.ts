import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfiguredOhMyPiAgentDir } from '../directSessions/resolveOhMyPiAgentDir';
import { resolveOhMyPiTerminalTranscriptBinding } from './resolveOhMyPiTerminalTranscriptBinding';
import { waitForOhMyPiTerminalTranscriptBinding } from './waitForOhMyPiTerminalTranscriptBinding';

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
    tempDirs.add(path);
    return path;
}

async function createAgentDir(root: string): Promise<string> {
    const agentDir = join(root, 'agent');
    await mkdir(join(agentDir, 'terminal-sessions'), { recursive: true });
    await mkdir(join(agentDir, 'sessions', 'workspace-encoded'), { recursive: true });
    return agentDir;
}

afterEach(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('waitForOhMyPiTerminalTranscriptBinding', () => {
    it('waits for the breadcrumb session file to materialize before returning a binding', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-binding-wait-')));
        const agentDir = await createAgentDir(root);
        const cwd = join(root, 'workspace');
        const sessionFile = join(agentDir, 'sessions', 'workspace-encoded', '1710000000000_remote-123.jsonl');
        const env = { PI_CODING_AGENT_DIR: agentDir };
        const expectedAgentDir = resolveConfiguredOhMyPiAgentDir(env);
        await writeFile(join(agentDir, 'terminal-sessions', 'pts-3'), `${cwd}\n${sessionFile}\n`, 'utf8');
        expect(resolveOhMyPiTerminalTranscriptBinding({
            cwd,
            env,
            terminalId: 'pts-3',
        })).toEqual({
            providerId: 'ohMyPi',
            source: {
                kind: 'ohMyPiAgentDir',
                agentDir: expectedAgentDir,
            },
            remoteSessionId: 'remote-123',
            env,
        });

        const bindingPromise = waitForOhMyPiTerminalTranscriptBinding({
            cwd,
            env,
            terminalId: 'pts-3',
            timeoutMs: 500,
            pollIntervalMs: 10,
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        await writeFile(sessionFile, '', 'utf8');

        await expect(bindingPromise).resolves.toEqual({
            providerId: 'ohMyPi',
            source: {
                kind: 'ohMyPiAgentDir',
                agentDir: expectedAgentDir,
            },
            remoteSessionId: 'remote-123',
            env,
        });
    });

    it('returns undefined when the session file never materializes before the timeout', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-binding-timeout-')));
        const agentDir = await createAgentDir(root);
        const cwd = join(root, 'workspace');
        const sessionFile = join(agentDir, 'sessions', 'workspace-encoded', '1710000000000_remote-123.jsonl');
        await writeFile(join(agentDir, 'terminal-sessions', 'pts-3'), `${cwd}\n${sessionFile}\n`, 'utf8');

        await expect(waitForOhMyPiTerminalTranscriptBinding({
            cwd,
            env: { PI_CODING_AGENT_DIR: agentDir },
            terminalId: 'pts-3',
            timeoutMs: 40,
            pollIntervalMs: 10,
        })).resolves.toBeUndefined();
    });
});
