import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    resolveCanonicalConfiguredClaudeConfigDir,
    resolveClaudeConfigDir,
    validateClaudeExternalSessionSource,
} from './source.js';

describe('Claude external session source leaf', () => {
    it('canonicalizes the configured Claude config dir and honors Happier override precedence', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-external-source-'));
        const configured = join(root, 'configured');
        await mkdir(configured, { recursive: true });

        const resolved = await realpath(configured);

        expect(resolveCanonicalConfiguredClaudeConfigDir({
            env: {
                HAPPIER_CLAUDE_CONFIG_DIR: ` ${configured} `,
                CLAUDE_CONFIG_DIR: join(root, 'ignored'),
            },
        })).toBe(resolved);
    });

    it('rejects source config dirs that do not match the configured Claude config dir', () => {
        const result = validateClaudeExternalSessionSource({
            source: { kind: 'claudeConfig', configDir: '/tmp/other-claude', projectId: null },
            env: { HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/configured-claude' },
        });

        expect(result).toEqual({ ok: false, error: 'source configDir override is not allowed' });
    });

    it('resolves Claude config sources without reviving legacy internal vocabulary', () => {
        expect(resolveClaudeConfigDir({
            source: { kind: 'claudeConfig', configDir: ' /tmp/source-claude ', projectId: 'project-a' },
            env: {},
        })).toBe('/tmp/source-claude');
    });
});
