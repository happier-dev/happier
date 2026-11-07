import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { readActionCatalog } from './deriveActionDtos.mjs';

test('canonical Action families resolve named object members without executing their owner', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'happier-action-members-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actions = resolve(root, 'packages/protocol/src/actions');
  mkdirSync(actions, { recursive: true });
  writeFileSync(resolve(actions, 'priceIds.ts'), `
    throw new Error('Catalog source must not execute');
    export const IDS = Object.freeze({ get: 'usage.price.get', set: 'usage.price.set' });
    export const ID_MAP = new Map([['read', IDS.get], ['write', IDS.set]] as const);
    export const READ_KEY = 'read';
    export const WRITE_KEY = 'set';
  `);
  writeFileSync(resolve(actions, 'actionIds.ts'), `
    import { IDS as IMPORTED_IDS, ID_MAP, READ_KEY, WRITE_KEY } from './priceIds.js';
    const IDS = IMPORTED_IDS;
    export const ACTION_ID_FAMILIES_V1 = {
      reads: [IDS.get], writes: [IDS.set],
      lookups: [IDS[WRITE_KEY], ID_MAP.get(READ_KEY), ID_MAP.get('write')],
    } as const;
  `);
  writeFileSync(resolve(actions, 'pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {} as const;');
  assert.deepEqual(readActionCatalog(root).families, {
    reads: ['usage.price.get'], writes: ['usage.price.set'],
    lookups: ['usage.price.set', 'usage.price.get', 'usage.price.set'],
  });
});
