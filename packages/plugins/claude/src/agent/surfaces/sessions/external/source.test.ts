import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    resolveConfiguredClaudeConfigDir,
    resolveCanonicalConfiguredClaudeConfigDir,
    resolveClaudeConfigDir,
    validateClaudeExternalSessionSource,
} from './source.js';

describe('Claude external session source leaf', () => {
    it('canonicalizes the configured Claude config dir and honors Claude process precedence', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-external-source-'));
        const configured = join(root, 'configured');
        await mkdir(configured, { recursive: true });

        const resolved = await realpath(configured);

        expect(resolveCanonicalConfiguredClaudeConfigDir({
            env: {
                CLAUDE_CONFIG_DIR: ` ${configured} `,
                HAPPIER_CLAUDE_CONFIG_DIR: join(root, 'ignored'),
            },
        })).toBe(resolved);
    });

    it('accepts either config variable when it is the only configured root', () => {
        expect(resolveConfiguredClaudeConfigDir({
            env: { CLAUDE_CONFIG_DIR: ' /tmp/claude-explicit ' },
        })).toBe('/tmp/claude-explicit');
        expect(resolveConfiguredClaudeConfigDir({
            env: { HAPPIER_CLAUDE_CONFIG_DIR: ' /tmp/claude-happier ' },
        })).toBe('/tmp/claude-happier');
    });

    /**
     * Whether a requested config dir is one the machine environment or the
     * account's settings authorized is decided by the host admission boundary
     * (`admitCallerChosenExternalSessionSourceFields`), which compares the
     * canonical forms this leaf produces. The leaf canonicalizes and decides
     * nothing, so both sides of that comparison come from one implementation.
     */
    it('canonicalizes a requested config dir instead of deciding whether it is allowed', () => {
        expect(validateClaudeExternalSessionSource({
            source: { kind: 'claudeConfig', configDir: ' /tmp/other-claude/ ', projectId: null },
            env: { HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/configured-claude' },
        })).toEqual({
            ok: true,
            source: { kind: 'claudeConfig', configDir: '/tmp/other-claude', projectId: null },
        });
    });

    it('fills the configured config dir when the source omits one', () => {
        expect(validateClaudeExternalSessionSource({
            source: { kind: 'claudeConfig', projectId: null },
            env: { HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/configured-claude' },
        })).toEqual({
            ok: true,
            source: { kind: 'claudeConfig', configDir: '/tmp/configured-claude', projectId: null },
        });
    });

    it('resolves Claude config sources without reviving legacy internal vocabulary', () => {
        expect(resolveClaudeConfigDir({
            source: { kind: 'claudeConfig', configDir: ' /tmp/source-claude ', projectId: 'project-a' },
            env: {},
        })).toBe('/tmp/source-claude');
    });

    it('uses the caller environment home when no Claude config-dir override is set', () => {
        expect(resolveConfiguredClaudeConfigDir({
            env: { HOME: '/tmp/claude-user-config' },
        })).toBe('/tmp/claude-user-config/.claude');
    });
});
