import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test('feature-policy manifests exist and can generate embedded policy module', async () => {
  const policyDir = join(repoRoot, '.github', 'feature-policy');
  const previewPath = join(policyDir, 'preview.json');
  const productionPath = join(policyDir, 'production.json');

  const preview = parseJson(await readFile(previewPath, 'utf8'));
  const production = parseJson(await readFile(productionPath, 'utf8'));

  for (const [label, doc] of [
    ['preview', preview],
    ['production', production],
  ]) {
    assert.ok(doc && typeof doc === 'object', `${label} policy must be an object`);
    assert.ok(doc.buildPolicy && typeof doc.buildPolicy === 'object', `${label} policy must include buildPolicy`);
    assert.ok(Array.isArray(doc.buildPolicy.allow), `${label} buildPolicy.allow must be an array`);
    assert.ok(Array.isArray(doc.buildPolicy.deny), `${label} buildPolicy.deny must be an array`);
  }

  assert.ok(
    production.buildPolicy.allow.length > 0,
    'production buildPolicy.allow must be non-empty (allowlist mode)'
  );

  const outDir = await mkdtemp(join(tmpdir(), 'happier-feature-policy-'));
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'embeddedFeaturePolicies.generated.ts');

  const scriptPath = join(
    repoRoot,
    'packages',
    'protocol',
    'scripts',
    'generate-embedded-feature-policies.mjs',
  );

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--policy-dir', policyDir, '--out', outPath],
    {
      env: {
        ...process.env,
        HAPPIER_EMBEDDED_POLICY_ENV: 'production',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || `generator exited with status ${result.status}`,
  );

  const generated = await readFile(outPath, 'utf8');
  assert.match(generated, /DEFAULT_EMBEDDED_FEATURE_POLICY_ENV/, 'generated module must export default env');
  assert.match(generated, /production/, 'generated module should embed production as the default env');
  assert.match(generated, /EMBEDDED_FEATURE_BUILD_POLICY_RAW/, 'generated module must export embedded policy raw values');
});

