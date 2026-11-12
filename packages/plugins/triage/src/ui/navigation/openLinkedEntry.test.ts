import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { openTriageLinkedEntry } from './openLinkedEntry.js';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';

it('retains the original typed navigation failure while settling cancellations quietly', async () => {
  const error = new PluginError({ code: 'destination_unavailable', details: { requestId: 'linked-17' } });
  const result = await openTriageLinkedEntry({ openSurface: async () => { throw error; } }, testkitEntryRef());
  expect(result).toEqual({ kind: 'refused', reason: 'unavailable', error });
  expect(await openTriageLinkedEntry({ openSurface: async () => { throw new PluginError({ code: 'cancelled' }); } }, testkitEntryRef()))
    .toEqual({ kind: 'cancelled' });
});
