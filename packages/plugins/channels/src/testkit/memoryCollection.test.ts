import { expect, it } from 'vitest';
import { CHANNEL_STATE_INDEX_ID } from '../collections.js';
import { MemoryCollection } from './memoryCollection.js';

it('matches the native connection index null binding sentinel and trailing kind/attention keys', async () => {
  const collection = new MemoryCollection();
  // Only index keys matter at this storage boundary; domain envelope parsing
  // remains with the real readers used by the composed Channels journeys.
  for (const row of [
    { id: 'connection', 'connection-id': 'connection-1', 'record-kind': 'connection', attention: false },
    { id: 'census-clear', 'connection-id': 'connection-1', 'record-kind': 'ingress-census', attention: false },
    { id: 'census-conflict', 'connection-id': 'connection-1', 'record-kind': 'ingress-census', attention: true },
    { id: 'bound-member', 'connection-id': 'connection-1', 'binding-id': 'binding-1', 'record-kind': 'ingress-obligation', attention: true },
    { id: 'other-connection', 'connection-id': 'connection-2', 'record-kind': 'ingress-census', attention: true },
  ]) await collection.put(row, { expectedRevision: 'absent' });
  const censuses = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
    prefix: ['connection-1', null, 'ingress-census'], limit: 10 });
  expect(censuses.rows.map(row => row.rowId)).toEqual(['census-clear', 'census-conflict']);
  const conflicts = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
    prefix: ['connection-1', null, 'ingress-census', true], limit: 10 });
  expect(conflicts.rows.map(row => row.rowId)).toEqual(['census-conflict']);
});

it('uses the native default page size and nullable numeric range ordering', async () => {
  const collection = new MemoryCollection();
  for (let index = 0; index < 51; index += 1) {
    await collection.put({ id: `obligation-${index}`, 'record-kind': 'ingress-obligation', 'due-at': index },
      { expectedRevision: 'absent' });
  }
  const first = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byIngressDue,
    prefix: ['ingress-obligation'], order: 'asc' });
  expect(first.rows).toHaveLength(50);
  expect(first.nextCursor).toBeDefined();
  const afterNull = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byIngressDue,
    prefix: ['ingress-obligation'], range: { lower: null, upper: 1 }, order: 'asc', limit: 10 });
  expect(afterNull.rows.map(row => row.value['due-at'])).toEqual([0, 1]);
  const throughNull = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byIngressDue,
    prefix: ['ingress-obligation'], range: { upper: null }, order: 'asc', limit: 10 });
  expect(throughNull.rows).toEqual([]);
});
