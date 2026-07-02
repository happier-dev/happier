import { describe, expect, it } from 'vitest';

import { createCodexRolloutDisplayTitleHandler } from './displayTitle';

describe('createCodexRolloutDisplayTitleHandler', () => {
    it('reads rollout titles through the provider field handler', async () => {
        const handler = createCodexRolloutDisplayTitleHandler({
            readTitle: async () => ' Rollout title ',
        });

        await expect(handler.readField?.({ sessionId: 'sess-1' })).resolves.toBe(' Rollout title ');
    });

    it('does not export a stale app-server title write handler', async () => {
        const module = await import('./displayTitle');

        expect(module).not.toHaveProperty('createCodexAppServerDisplayTitleHandler');
    });
});
