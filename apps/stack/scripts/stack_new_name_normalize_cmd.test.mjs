import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStackNewMonorepoFixture } from './stack_new_monorepo.testHelper.mjs';

test('hstack stack new normalizes stack names across valid and punctuation-heavy inputs', async (t) => {
  const fixture = await setupStackNewMonorepoFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happier-stack-new-name-',
  });
  await fixture.createMonorepoCheckout('main', { includeServerPrisma: true });

  const cases = [
    { rawName: 'My Stack', normalized: 'my-stack' },
    { rawName: 'already-valid', normalized: 'already-valid' },
    { rawName: '  MIXED__Case...Name  ', normalized: 'mixed-case-name' },
    { rawName: 'alpha---beta', normalized: 'alpha-beta' },
  ];

  for (const testCase of cases) {
    const res = await fixture.runStackNew([testCase.rawName, '--json']);
    assert.equal(
      res.code,
      0,
      `${testCase.rawName}: expected exit 0, got ${res.code} (signal: ${res.signal})\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.stackName, testCase.normalized, `${testCase.rawName}: unexpected stackName`);
    assert.ok(
      typeof parsed?.envPath === 'string' && parsed.envPath.includes(`/${testCase.normalized}/env`),
      `${testCase.rawName}: unexpected envPath ${parsed?.envPath}`
    );

    const contents = await fixture.readStackEnv(testCase.normalized);
    assert.ok(contents.includes(`HAPPIER_STACK_STACK=${testCase.normalized}\n`), `${testCase.rawName}\n${contents}`);
  }
});
