import assert from 'node:assert/strict';
import test from 'node:test';

import { DEPRECATED_IMPORT_RULES, findDeprecatedImportMatches } from './deprecatedImportRules.ts';

test('deprecated import rules expose unique ids and replacements', () => {
  const ids = new Set(DEPRECATED_IMPORT_RULES.map((rule) => rule.id));

  assert.equal(ids.size, DEPRECATED_IMPORT_RULES.length);
  assert.ok(DEPRECATED_IMPORT_RULES.every((rule) => rule.replacement));
});

test('deprecated import matching is exact to the import specifier', () => {
  const matches = findDeprecatedImportMatches(
    'apps/ui/sources/example.test.tsx',
    "import { testUiMocks } from '@/dev/testkit/testUiMocks';\nimport { other } from '@/dev/testkit/testUiMocksExtra';",
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.rule.from, '@/dev/testkit/testUiMocks');
});
