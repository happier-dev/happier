import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('cli-common source tests do not enter the package publication lifecycle', () => {
  expect(packageJson.scripts['test:local']).toBe(
    'node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts',
  );
});
