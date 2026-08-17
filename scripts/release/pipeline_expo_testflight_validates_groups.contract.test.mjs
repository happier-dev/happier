import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const validGroupId = '11111111-2222-4333-8444-555555555555';

function runValidation(selection) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-groups-'));
  const preloadPath = path.join(fixtureRoot, 'mock-asc.mjs');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  fs.writeFileSync(
    preloadPath,
    `globalThis.fetch = async (url) => {
  const pathname = new URL(url).pathname;
  if (pathname === '/v1/apps/6761304097/betaGroups') {
    return Response.json({
      data: [{
        type: 'betaGroups',
        id: '${validGroupId}',
        attributes: { name: 'Happier (dev)', isInternalGroup: false },
      }],
    });
  }
  return Response.json({ errors: [{ code: 'UNEXPECTED_TEST_URL', detail: pathname }] }, { status: 500 });
};
`,
  );

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preloadPath,
      'scripts/pipeline/expo/testflight-distribute.mjs',
      '--environment=dev',
      `--external-groups=${selection}`,
      '--validate-groups-only',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, APPLE_API_PRIVATE_KEY: privateKeyPem },
    },
  );

  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
}

test('TestFlight group validation verifies a configured name before build processing', () => {
  const result = runValidation('Happier (dev)');

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`validated external TestFlight group Happier \\(dev\\) \\(${validGroupId}\\)`));
});

test('TestFlight group validation rejects a stale id and reports the app external groups', () => {
  const staleGroupId = '78315e16-c539-43ae-a65e-4f465dccaf68';
  const result = runValidation(staleGroupId);

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(`Unable to find external TestFlight group '${staleGroupId}'`));
  assert.match(result.stderr, new RegExp(`Happier \\(dev\\) \\(${validGroupId}\\)`));
});
