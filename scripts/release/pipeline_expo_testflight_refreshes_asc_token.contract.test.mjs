import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('TestFlight distribution mints a fresh App Store Connect token for every request', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-token-refresh-'));
  const preloadPath = path.join(fixtureRoot, 'mock-asc.mjs');
  const observedTokensPath = path.join(fixtureRoot, 'observed-tokens.jsonl');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  fs.writeFileSync(
    preloadPath,
    `import fs from 'node:fs';

const realDateNow = Date.now;
let requestTime = realDateNow();
Date.now = () => requestTime;

globalThis.fetch = async (url, init = {}) => {
  const authorization = String(init.headers?.Authorization ?? '');
  fs.appendFileSync(process.env.HAPPIER_TEST_ASC_TOKENS_PATH, JSON.stringify(authorization) + '\\n');
  requestTime += 60_000;

  const pathname = new URL(url).pathname;
  if (pathname === '/v1/builds') {
    return Response.json({
      data: [{
        type: 'builds',
        id: 'build-1',
        attributes: { version: '271', uploadedDate: '2026-08-04T17:00:00Z', processingState: 'VALID' },
        relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'version-1' } } },
      }],
      included: [{ type: 'preReleaseVersions', id: 'version-1', attributes: { version: '0.2.10' } }],
    });
  }
  if (pathname === '/v1/betaGroups/78315e16-c539-43ae-a65e-4f465dccaf68/relationships/builds') return Response.json({});
  if (pathname === '/v1/betaAppReviewSubmissions') return Response.json({ data: { type: 'betaAppReviewSubmissions', id: 'submission-1' } });
  return Response.json({ errors: [{ code: 'UNEXPECTED_TEST_URL', detail: pathname }] }, { status: 500 });
};
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preloadPath,
        'scripts/pipeline/expo/testflight-distribute.mjs',
        '--environment=dev',
        '--external-groups=78315e16-c539-43ae-a65e-4f465dccaf68',
        '--build-number=271',
        '--app-version=0.2.10',
        '--wait-processing=false',
        '--submit-beta-review=true',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          APPLE_API_PRIVATE_KEY: privateKeyPem,
          HAPPIER_TEST_ASC_TOKENS_PATH: observedTokensPath,
        },
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const tokens = fs
      .readFileSync(observedTokensPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(tokens.length, 3);
    assert.equal(new Set(tokens).size, tokens.length, 'each App Store Connect request must use a newly minted JWT');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
