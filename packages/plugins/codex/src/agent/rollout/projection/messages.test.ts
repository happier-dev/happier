import { describe, expect, it } from 'vitest';

import { projectCodexRolloutActions } from './messages.js';
import type { CodexRolloutAction } from './actions.js';

describe('projectCodexRolloutActions', () => {
    it('projects subagent lifecycle as subagent facts rather than synthetic transcript tools', () => {
        const actions: CodexRolloutAction[] = [
            {
                type: 'subagent-spawn',
                threadId: 'codex-child-thread-1',
                prompt: 'inspect the repo',
                nickname: 'Lovelace',
                role: 'explorer',
            },
            {
                type: 'subagent-complete',
                threadId: 'codex-child-thread-1',
                status: 'completed',
                summaryText: 'done',
            },
        ];

        expect(projectCodexRolloutActions(actions, { sidechainId: null })).toEqual([
            {
                type: 'subagent-spawn',
                threadId: 'codex-child-thread-1',
                prompt: 'inspect the repo',
                nickname: 'Lovelace',
                role: 'explorer',
            },
            {
                type: 'subagent-complete',
                threadId: 'codex-child-thread-1',
                status: 'completed',
                summaryText: 'done',
            },
        ]);
    });
});
