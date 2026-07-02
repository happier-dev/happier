import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveOhMyPiTerminalTranscriptBinding } from './resolveOhMyPiTerminalTranscriptBinding';

function makeAgentDir(root: string): string {
    const agentDir = join(root, 'agent');
    mkdirSync(join(agentDir, 'terminal-sessions'), { recursive: true });
    mkdirSync(join(agentDir, 'sessions', 'workspace-encoded'), { recursive: true });
    return agentDir;
}

describe('resolveOhMyPiTerminalTranscriptBinding', () => {
    it('reads the breadcrumb, validates cwd, and returns a direct transcript binding', () => {
        const root = join(process.cwd(), `.project/tmp/ohmypi-${Date.now()}-binding`);
        const agentDir = makeAgentDir(root);
        const cwd = join(root, 'workspace');
        const sessionFile = join(agentDir, 'sessions', 'workspace-encoded', '1710000000000_remote-123.jsonl');
        writeFileSync(join(agentDir, 'terminal-sessions', 'pts-3'), `${cwd}\n${sessionFile}\n`);

        const binding = resolveOhMyPiTerminalTranscriptBinding({
            cwd,
            env: { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
            terminalId: 'pts-3',
        });

        expect(binding).toEqual({
            providerId: 'ohMyPi',
            source: {
                kind: 'ohMyPiAgentDir',
                agentDir,
            },
            remoteSessionId: 'remote-123',
            env: { PI_CODING_AGENT_DIR: agentDir },
        });
    });

    it('returns undefined when the breadcrumb cwd does not match', () => {
        const root = join(process.cwd(), `.project/tmp/ohmypi-${Date.now()}-mismatch`);
        const agentDir = makeAgentDir(root);
        const cwd = join(root, 'workspace');
        const sessionFile = join(agentDir, 'sessions', 'workspace-encoded', '1710000000000_remote-123.jsonl');
        writeFileSync(join(agentDir, 'terminal-sessions', 'pts-3'), `${join(root, 'other')}\n${sessionFile}\n`);

        const binding = resolveOhMyPiTerminalTranscriptBinding({
            cwd,
            env: { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
            terminalId: 'pts-3',
        });

        expect(binding).toBeUndefined();
    });

    it('rejects breadcrumbs with extra non-empty lines through the shared breadcrumb contract', () => {
        const root = join(process.cwd(), `.project/tmp/ohmypi-${Date.now()}-extra-lines`);
        const agentDir = makeAgentDir(root);
        const cwd = join(root, 'workspace');
        const sessionFile = join(agentDir, 'sessions', 'workspace-encoded', '1710000000000_remote-123.jsonl');
        writeFileSync(join(agentDir, 'terminal-sessions', 'pts-3'), `${cwd}\n${sessionFile}\nunexpected\n`);

        const binding = resolveOhMyPiTerminalTranscriptBinding({
            cwd,
            env: { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
            terminalId: 'pts-3',
        });

        expect(binding).toBeUndefined();
    });
});
