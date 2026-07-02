import { describe, expect, it } from 'vitest';

import { resolveCodexTerminalRuntimeTranscriptBinding } from './transcriptBinding.js';

describe('resolveCodexTerminalRuntimeTranscriptBinding', () => {
    it('returns a direct-transcript binding for canonical rollout files whose filename includes the resume id', () => {
        const binding = resolveCodexTerminalRuntimeTranscriptBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/codex-home/sessions/2026/04/05/rollout-2026-04-05T10-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            sessionMetaId: null,
            env: process.env,
        });

        expect(binding).toEqual({
            providerId: 'codex',
            env: process.env,
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/tmp/codex-home',
            },
        });
    });

    it('returns a direct-transcript binding for canonical flat rollout files when session_meta.id matches the resume id', () => {
        const binding = resolveCodexTerminalRuntimeTranscriptBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/codex-home/sessions/rollout-2026-04-05T10-00-00-flat.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            sessionMetaId: '123e4567-e89b-12d3-a456-426614174000',
            env: process.env,
        });

        expect(binding).toEqual({
            providerId: 'codex',
            env: process.env,
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/tmp/codex-home',
            },
        });
    });

    it('does not return a direct-transcript binding for rollout files outside the canonical CODEX_HOME sessions tree', () => {
        const binding = resolveCodexTerminalRuntimeTranscriptBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/overridden-sessions/rollout-2026-04-05T10-00-00-flat.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            sessionMetaId: '123e4567-e89b-12d3-a456-426614174000',
            env: process.env,
        });

        expect(binding).toBeUndefined();
    });

    it('does not bind canonical rollout files when the filename only contains the remote session id as a substring', () => {
        const binding = resolveCodexTerminalRuntimeTranscriptBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/codex-home/sessions/2026/04/05/rollout-2026-04-05T10-00-00-abc123.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: 'abc',
            sessionMetaId: null,
            env: process.env,
        });

        expect(binding).toBeUndefined();
    });
});
