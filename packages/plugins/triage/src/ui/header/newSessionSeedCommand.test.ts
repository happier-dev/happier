import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { requestTriageNewSessionSeed } from './newSessionSeedCommand.js';

it('keeps the preparation refusal Code and Request ID for the person', async () => {
    const result = await requestTriageNewSessionSeed({
        version: () => ({ methods: ['openNewSession'] }),
        openNewSession: async () => { throw new PluginError({ code: 'unavailable',
            diagnostics: [{ code: 'workspaceRequired', severity: 'error' }], details: { requestId: 'prepare-17' } }); },
    }, { checkoutIntent: 'preparedReviewWorkspace' });
    expect(result).toEqual({ status: 'unavailable', failure: { codes: ['unavailable', 'workspaceRequired'], requestId: 'prepare-17' } });
});
