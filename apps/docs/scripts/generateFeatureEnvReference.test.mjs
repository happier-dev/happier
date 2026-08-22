import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { cleanComment, groupTitle, parseFeatureEnvSchema, splitByArea, ensureUniqueTitles } from './generateFeatureEnvReference.mjs';

const SCHEMA = `export const FEATURE_ENV_KEYS = Object.freeze({
  automationsEnabled: 'HAPPIER_FEATURE_AUTOMATIONS__ENABLED',

  // Core gates (§4.1/§13.5.3) and a note.
  bugReportsEnabled: 'HAPPIER_FEATURE_BUG_REPORTS__ENABLED',
  bugReportsMaxArtifactBytes: 'HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES',

  sessionsHandoffEnabled: 'HAPPIER_FEATURE_SESSIONS_HANDOFF__ENABLED',
  machinesTunnelServerRoutedMaxBytes:
    'HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES',
});`;

test('captures entries whose value wraps onto the next line', () => {
  const groups = parseFeatureEnvSchema(SCHEMA);
  const keys = groups.flatMap((g) => g.entries.map((e) => e.key));
  // The wrapped machines entry is the one a line-by-line parser drops.
  assert.ok(keys.includes('HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES'));
  assert.equal(keys.length, 5);
});

test('keeps blank-line groups and their leading comment', () => {
  const groups = parseFeatureEnvSchema(SCHEMA);
  assert.equal(groups.length, 3);
  assert.match(groups[1].comment, /Core gates/);
});

test('names a group by its shared prefix, not its first segment', () => {
  // `BUG` alone would read "Bug", and AUTH_MTLS/AUTH_OAUTH would collide.
  assert.equal(groupTitle([{ key: 'HAPPIER_FEATURE_BUG_REPORTS__ENABLED' }, { key: 'HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES' }]), 'Bug reports');
});

test('splits a mixed group so tunnel variables sit under Machines', () => {
  const mixed = parseFeatureEnvSchema(SCHEMA)[2];
  const parts = splitByArea(mixed);
  assert.deepEqual(parts.map((p) => groupTitle(p.entries)), ['Sessions handoff', 'Machines tunnel server routed']);
});

test('disambiguates two sections that would share an anchor', () => {
  const sections = ensureUniqueTitles([
    { title: 'Auth', entries: [{ key: 'HAPPIER_FEATURE_AUTH_MTLS__ENABLED' }] },
    { title: 'Auth', entries: [{ key: 'HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED' }] },
  ]);
  assert.equal(new Set(sections.map((s) => s.title)).size, 2);
});

test('drops internal design-document citations from carried comments', () => {
  assert.equal(cleanComment('Core gates (§4.1/§13.5.3) and a note.'), 'Core gates and a note.');
});
