import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('relay-server publishConfig does not force provenance (pipeline controls provenance)', () => {
  const pkgPath = path.join(repoRoot, 'packages', 'relay-server', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const publishConfig = pkg.publishConfig ?? {};
  assert.ok(publishConfig && typeof publishConfig === 'object');

  // Local publishes (token-based) frequently run outside of OIDC providers; forcing provenance
  // breaks local iteration. Provenance is enabled in CI by the pipeline instead.
  assert.ok(!('provenance' in publishConfig), 'publishConfig.provenance must be absent');
});

