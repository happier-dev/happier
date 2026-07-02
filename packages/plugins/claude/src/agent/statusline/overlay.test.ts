import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    buildClaudeStatuslineOverlaySettings,
    resolveClaudeStatuslineOriginalCommand,
} from './overlay.js';

const tempDirs: string[] = [];

function createConfigDir(settings?: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'claude-statusline-overlay-'));
    tempDirs.push(dir);
    if (settings !== undefined) {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
    }
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('resolveClaudeStatuslineOriginalCommand', () => {
    it('resolves the configured statusline command and padding from the spawned config root', () => {
        const configDir = createConfigDir({
            statusLine: { type: 'command', command: '~/bin/my-statusline.sh', padding: 2 },
        });

        const original = resolveClaudeStatuslineOriginalCommand({ env: { CLAUDE_CONFIG_DIR: configDir } });

        expect(original).toEqual({ command: '~/bin/my-statusline.sh', padding: 2 });
    });

    it('prefers HAPPIER_CLAUDE_CONFIG_DIR over CLAUDE_CONFIG_DIR', () => {
        const happierDir = createConfigDir({ statusLine: { type: 'command', command: 'happier-status' } });
        const claudeDir = createConfigDir({ statusLine: { type: 'command', command: 'claude-status' } });

        const original = resolveClaudeStatuslineOriginalCommand({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: happierDir, CLAUDE_CONFIG_DIR: claudeDir },
        });

        expect(original?.command).toBe('happier-status');
    });

    it('returns null for missing settings, non-command statuslines, and malformed values (fail-open)', () => {
        const missing = createConfigDir();
        expect(resolveClaudeStatuslineOriginalCommand({ env: { CLAUDE_CONFIG_DIR: missing } })).toBeNull();

        const wrongType = createConfigDir({ statusLine: { type: 'static', text: 'hello' } });
        expect(resolveClaudeStatuslineOriginalCommand({ env: { CLAUDE_CONFIG_DIR: wrongType } })).toBeNull();

        const emptyCommand = createConfigDir({ statusLine: { type: 'command', command: '   ' } });
        expect(resolveClaudeStatuslineOriginalCommand({ env: { CLAUDE_CONFIG_DIR: emptyCommand } })).toBeNull();

        const notObject = createConfigDir({ statusLine: 'top-level-string' });
        expect(resolveClaudeStatuslineOriginalCommand({ env: { CLAUDE_CONFIG_DIR: notObject } })).toBeNull();
    });
});

describe('buildClaudeStatuslineOverlaySettings', () => {
    it('builds a secret-free command referencing the 0600 secret file and round-trips the original via base64', () => {
        const settings = buildClaudeStatuslineOverlaySettings({
            nodeExecutable: '/managed/bin/node',
            forwarderScriptPath: '/assets/statusline_forwarder.cjs',
            port: 43123,
            secretFilePath: '/tmp/hook-secrets/session.secret',
            original: { command: 'echo "my fancy" $STATUS | jq .', padding: 1 },
        });

        expect(settings.type).toBe('command');
        expect(settings.padding).toBe(1);
        expect(settings.command).toContain('"/managed/bin/node"');
        expect(settings.command).toContain('"/assets/statusline_forwarder.cjs"');
        expect(settings.command).toContain('43123');
        expect(settings.command).toContain('--secret-file "/tmp/hook-secrets/session.secret"');

        const b64Match = settings.command.match(/--original-b64 ([A-Za-z0-9+/=]+)/);
        expect(b64Match).not.toBeNull();
        expect(Buffer.from(b64Match![1], 'base64').toString('utf8')).toBe('echo "my fancy" $STATUS | jq .');
    });

    it('omits the original/padding parts when no original statusline is configured', () => {
        const settings = buildClaudeStatuslineOverlaySettings({
            nodeExecutable: '/managed/bin/node',
            forwarderScriptPath: '/assets/statusline_forwarder.cjs',
            port: 43123,
            secretFilePath: null,
            original: null,
        });

        expect(settings.command).not.toContain('--original-b64');
        expect(settings.command).not.toContain('--secret-file');
        expect(settings.padding).toBeUndefined();
    });
});
