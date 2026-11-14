import { describe, expect, it } from 'vitest';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';

const { watchedServiceItems } = await import('./watchedServiceItems');

const watch = (
  machineId: string,
  watchId: string,
  nativeResourceId: string,
) => ({
  key: `watch:${machineId}:${watchId}`,
  machineId,
  native: {
    v: 1 as const,
    watchId,
    name: watchId,
    adapter: { pluginId: 'p', localId: 'docker' },
    nativeResourceId,
    lifecyclePurpose: 'infrastructure' as const,
  },
});

const row = (serviceId: string, watchId: string): MachineServiceRowV1 =>
  ({
    serviceId,
    name: watchId,
    authority: 'machine',
    lifecyclePurpose: 'infrastructure',
    generation: 'g1',
    state: 'running',
    watchId,
    watchRevision: 'r1',
    capabilities: {
      exec: false,
      start: false,
      stop: false,
      restart: false,
      logs: true,
      accounting: true,
    },
  }) as unknown as MachineServiceRowV1;

describe('watchedServiceItems (Services → Watched, lab svcWatch)', () => {
  it('joins each watch to the service its Machine lists for it by the watch identity the row carries', () => {
    const items = watchedServiceItems(
      [watch('m1', 'w-db', '["container-1","db"]')],
      new Map([
        [
          'm1',
          {
            status: 'listed' as const,
            rows: [row('svc-generation-7', 'w-db')],
          },
        ],
      ]),
    );
    expect(items[0]!.service?.serviceId).toBe('svc-generation-7');
    expect(items[0]!.read).toBe('listed');
  });

  it('says a Machine is still being read, or could not be read, and never carries the native resource id to draw', () => {
    const items = watchedServiceItems(
      [
        watch('m1', 'w-db', '["container-1","db"]'),
        watch('m2', 'w-web', '["container-2","web"]'),
      ],
      new Map([['m2', { status: 'failed' as const, rows: null }]]),
    );
    expect(items.map((item) => [item.key, item.service, item.read])).toEqual([
      ['watch:m1:w-db', null, 'reading'],
      ['watch:m2:w-web', null, 'failed'],
    ]);
    expect(JSON.stringify(items)).not.toContain('container-1');
  });

  it('keeps the last listed rows while a later read fails', () => {
    const items = watchedServiceItems(
      [watch('m1', 'w-db', 'x')],
      new Map([
        ['m1', { status: 'failed' as const, rows: [row('svc', 'w-db')] }],
      ]),
    );
    expect(items[0]!.service?.serviceId).toBe('svc');
  });
});
