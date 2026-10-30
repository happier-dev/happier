import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  REFERENCE_END,
  REFERENCE_START,
  escapeCell,
  formatDefault,
  formatType,
  renderFeatureEnvReferenceMarkdown,
  renderServerConfigReferenceSection,
  spliceReferenceSection,
} from './generateServerConfigReference.mjs';

const REGISTRY = {
  entries: [
    { key: 'HAPPIER_AUTH_EMAIL_SMTP_PORT', type: 'int', bounds: { min: 1, max: 65535 }, sensitivity: 'plain', apply: 'live', editable: 'home', section: 'email', description: 'SMTP port.', origin: 'base' },
    { key: 'DATABASE_URL', type: 'string', sensitivity: 'secret', apply: 'restart', editable: 'bootstrap', section: 'server', description: 'Database <url>.', reason: 'Read before the database opens.', origin: 'base' },
    { key: 'HAPPIER_DB_PROVIDER', type: 'enum', default: 'postgres', bounds: { values: ['postgres', 'sqlite'] }, aliases: ['HAPPY_DB_PROVIDER'], sensitivity: 'plain', apply: 'restart', editable: 'bootstrap', section: 'server', description: 'Database provider.', reason: 'Read before the database opens.', origin: 'base' },
    { key: 'HAPPIER_FEATURE_TEAMS__ENABLED', type: 'boolean', default: true, sensitivity: 'plain', apply: 'live', editable: 'home', section: 'features', family: 'teams', featureId: 'teams', description: 'Teams.', origin: 'features' },
    { key: 'HAPPIER_FEATURES_RATE_LIMIT_MAX', type: 'int', default: 120, bounds: { min: 0 }, sensitivity: 'plain', apply: 'restart', editable: 'home', section: 'server', family: 'rateLimits', description: 'Route limit.', origin: 'rateLimits' },
  ],
};

test('never renders a secret default and escapes MDX syntax in cells', () => {
  assert.equal(formatDefault({ sensitivity: 'secret', default: 'not-for-publication' }), 'secret');
  assert.equal(escapeCell('a | <b> {c}'), 'a \\| &lt;b> \\{c\\}');
  assert.equal(formatType(REGISTRY.entries[0]), 'int 1–65535');
  assert.equal(formatType(REGISTRY.entries[2]), 'one of `postgres`, `sqlite`');
});

test('lists every key except the families that have their own page, with aliases and who may set it', () => {
  const section = renderServerConfigReferenceSection(REGISTRY);
  assert.match(section, /`HAPPIER_DB_PROVIDER` \(alias `HAPPY_DB_PROVIDER`\)/);
  assert.match(section, /\| `HAPPIER_AUTH_EMAIL_SMTP_PORT` \| int 1–65535 \| — \| Live \| Home settings or env \|/);
  assert.match(section, /\| `DATABASE_URL` \| string \| secret \| Restart \| Env only \| Database &lt;url>\. \|/);
  assert.doesNotMatch(section, /HAPPIER_FEATURE_TEAMS__ENABLED/);
  assert.doesNotMatch(section, /HAPPIER_FEATURES_RATE_LIMIT_MAX/);
  assert.match(section, /The 1 feature keys/);
});

test('replaces only the generated section and is idempotent', () => {
  const page = `---\ntitle: Env\n---\n\nHand-written guidance.\n`;
  const once = spliceReferenceSection(page, `${REFERENCE_START}\nA\n${REFERENCE_END}`);
  const twice = spliceReferenceSection(once, `${REFERENCE_START}\nB\n${REFERENCE_END}`);
  assert.match(twice, /Hand-written guidance\./);
  assert.match(twice, /\nB\n/);
  assert.doesNotMatch(twice, /\nA\n/);
  assert.equal(spliceReferenceSection(twice, `${REFERENCE_START}\nB\n${REFERENCE_END}`), twice);
});

test('the feature page lists only feature keys, with their defaults', async () => {
  const page = await renderFeatureEnvReferenceMarkdown({ registry: REGISTRY });
  assert.match(page, /\| `HAPPIER_FEATURE_TEAMS__ENABLED` \| Switch \| boolean \| `true` \| Live \| Home settings or env \| Teams\. \|/);
  assert.doesNotMatch(page, /DATABASE_URL/);
});
