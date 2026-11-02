import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMutagenMonitorArgs } from './mutagen_monitor.mjs';

test('monitor selects owned names in its template so temporarily missing sessions do not fail daemon selection', () => {
  const args = buildMutagenMonitorArgs(['happier-live', 'happier-missing']);
  // Mutagen 0.18.1 rejects a missing positional specification before rendering
  // a template. An unqualified templated monitor permits an empty selection.
  assert.deepEqual(args.slice(0, 3), ['sync', 'monitor', '--template']);
  assert.equal(args.length, 4);
  assert.ok(args[3].includes('(eq .Name "happier-live")'));
  assert.ok(args[3].includes('(eq .Name "happier-missing")'));
});
