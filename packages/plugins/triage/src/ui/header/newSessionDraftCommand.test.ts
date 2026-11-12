import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { requestTriageNewSessionDraft } from './newSessionDraftCommand.js';

it('keeps a rejected New Session draft Code and Request ID and distinguishes cancellation', async () => {
  const version = () => ({ methods: ['selectActionInput'] });
  expect(await requestTriageNewSessionDraft({ version, selectActionInput: async () => { throw new PluginError({ code: 'selection_unavailable',
    diagnostics: [{ code: 'machine_offline', severity: 'error' }], details: { requestId: 'draft-17' } }); } }, null))
    .toEqual({ status: 'unavailable', failure: { codes: ['selection_unavailable', 'machine_offline'], requestId: 'draft-17' } });
  expect(await requestTriageNewSessionDraft({ version, selectActionInput: async () => { throw new PluginError({ code: 'cancelled' }); } }, null))
    .toEqual({ status: 'cancelled' });
});
