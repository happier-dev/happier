import { describe, expect, it } from 'vitest';

import { resolveCodexRolloutSessionStoreBinding } from './resolveCodexRolloutSessionStoreBinding';

describe('resolveCodexRolloutSessionStoreBinding', () => {
    it('returns a shared-store binding for canonical rollout files whose filename includes the resume id', () => {
        const binding = resolveCodexRolloutSessionStoreBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/codex-home/sessions/2026/04/05/rollout-2026-04-05T10-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            sessionMetaId: null,
        });

        expect(binding).toEqual({
            activeServerDir: '/tmp/happier-active-server',
            env: process.env,
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/tmp/codex-home',
            },
        });
    });

    it('returns a shared-store binding for canonical flat rollout files when session_meta.id matches the resume id', () => {
        const binding = resolveCodexRolloutSessionStoreBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/codex-home/sessions/rollout-2026-04-05T10-00-00-flat.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            sessionMetaId: '123e4567-e89b-12d3-a456-426614174000',
        });

        expect(binding).toEqual({
            activeServerDir: '/tmp/happier-active-server',
            env: process.env,
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/tmp/codex-home',
            },
        });
    });

    it('does not return a shared-store binding for rollout files outside the canonical CODEX_HOME sessions tree', () => {
        const binding = resolveCodexRolloutSessionStoreBinding({
            activeServerDir: '/tmp/happier-active-server',
            candidateFilePath: '/tmp/overridden-sessions/rollout-2026-04-05T10-00-00-flat.jsonl',
            codexHome: '/tmp/codex-home',
            remoteSessionId: '123e4567-e89b-12d3-a456-426614174000',
            sessionMetaId: '123e4567-e89b-12d3-a456-426614174000',
        });

        expect(binding).toBeUndefined();
    });
});
