import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
    spawn: spawnMock,
}));

vi.mock('@/agent/runtime/signalForwarding', () => ({
    attachProcessSignalForwardingToChild: vi.fn(),
}));

vi.mock('@/backends/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: vi.fn(),
}));

vi.mock('@/backends/claude/utils/claudeFindLastSession', () => ({
    claudeFindLastSession: vi.fn(),
}));

vi.mock('@/backends/claude/utils/ensureClaudeJsRuntimeExecutable', () => ({
    ensureClaudeJsRuntimeExecutable: vi.fn(),
}));

vi.mock('@/backends/claude/utils/getProjectPath', () => ({
    getProjectPath: vi.fn((_path: string) => '/tmp/project'),
}));

vi.mock('@/backends/claude/utils/resolveClaudeConfigDirEnvOverlay', () => ({
    resolveClaudeConfigDirEnvOverlay: vi.fn(() => ({})),
}));

vi.mock('@/backends/claude/utils/resolveClaudeConfigDirOverride', () => ({
    resolveClaudeConfigDirOverride: vi.fn(() => '/tmp/claude-config'),
}));

vi.mock('@/backends/claude/utils/resolveClaudeCliPath', () => ({
    isClaudeCliJavaScriptFile: vi.fn(() => false),
    resolveClaudeCliPath: vi.fn(() => '/tmp/claude'),
}));

vi.mock('@/backends/claude/utils/systemPrompt', () => ({
    getClaudeSystemPrompt: vi.fn(() => ''),
}));

vi.mock('@/ui/ink/restoreStdinBestEffort', () => ({
    restoreStdinBestEffort: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@/utils/processEnv/stripNestedSessionDetectionEnv', () => ({
    stripNestedSessionDetectionEnv: vi.fn((env: NodeJS.ProcessEnv) => env),
}));

vi.mock('@happier-dev/cli-common/process', () => ({
    resolveWindowsCommandInvocation: vi.fn(({ command, args }: { command: string; args: string[] }) => ({
        command,
        args,
    })),
}));

function createChildProcessMock(): EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
    stdio: Array<null>;
} {
    const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        killed: boolean;
        pid: number;
        stdio: Array<null>;
    };
    child.kill = vi.fn(() => true);
    child.killed = false;
    child.pid = 12345;
    child.stdio = [null, null, null, null];
    queueMicrotask(() => {
        child.emit('exit', 0, null);
    });
    return child;
}

describe('runClaudeTerminalSession', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => createChildProcessMock());
        vi.mocked(logger.debug).mockClear();
    });

    it('does not log raw user args or MCP config contents', async () => {
        const { logger } = await import('@/ui/logger');
        const { runClaudeTerminalSession } = await import('./runTerminalSession');

        await runClaudeTerminalSession({
            abort: new AbortController().signal,
            sessionId: 'session-1',
            path: '/tmp/project',
            onSessionFound: vi.fn(),
            hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--mcp-config', '{"mcpServers":{"custom":{"token":"secret"}}}', '--max-turns', '3'],
            systemPromptText: 'Prompt text',
        });

        const logged = vi.mocked(logger.debug).mock.calls
            .flat()
            .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
            .join('\n');

        expect(logged).not.toContain('--mcp-config');
        expect(logged).not.toContain('secret');
        expect(logged).not.toContain('Prompt text');
    });
});
