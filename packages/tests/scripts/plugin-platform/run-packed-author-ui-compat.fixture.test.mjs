import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const fixtureSourceUrl = new URL('./run-packed-author-ui-compat.test.mjs', import.meta.url);
const runnerSourceUrl = new URL('./run-packed-author-ui-compat.mjs', import.meta.url);

function testBlock(source, title) {
  const start = source.indexOf(`test('${title}'`);
  assert.notEqual(start, -1, `missing ${title} fixture`);
  const nextTest = source.indexOf("\ntest('", start + 1);
  const end = nextTest === -1 ? source.length : nextTest;
  return source.slice(start, end);
}

test('positive packed author fixtures retain the canonical app-page container and target', async () => {
  const source = await readFile(fixtureSourceUrl, 'utf8');
  const runnerSource = await readFile(runnerSourceUrl, 'utf8');
  const configuredManifest = testBlock(
    source,
    'vertical-a preserves the scaffold development entry while selecting its built daemon entry',
  );
  const configuredSource = testBlock(
    source,
    'vertical-a fixture configuration keeps its author test aligned with the roundtrip registration',
  );

  assert.doesNotMatch(configuredManifest, /placement:\s*'app\.sidePanel'/u);
  assert.match(
    configuredManifest,
    /views:\s*\[\{\s*id:\s*'main',\s*container:\s*'appPage',\s*target:\s*\{\s*kind:\s*'app'\s*\},\s*renderer:/u,
  );
  assert.doesNotMatch(configuredSource, /placement:\s*'app\.sidePanel'/u);
  assert.match(
    configuredSource,
    /defineUiSurfaceDefinition\(\{',\s*["']\s*id:\s*'main',["'],\s*["']\s*placement:\s*'appPage',["'],\s*["']\s*title:\s*'Vertical A',["'],\s*["']\s*renderer:\s*\{\s*kind:\s*'hostedWeb'/u,
  );

  assert.match(
    configuredManifest,
    /configured\.contributes\.ui\.views\.map\(\(\{ id, container, target, renderer \}\)/u,
  );
  assert.match(
    configuredSource,
    /assert\.deepEqual\(configuredManifest\.contributes\.ui\.views,\s*\[\{\s*id:\s*'main',\s*container:\s*'appPage',\s*target:\s*\{\s*kind:\s*'app'\s*\}/u,
  );

  const buildConfigStart = runnerSource.indexOf("writeFile(join(params.pluginRoot, 'pluginUiBuild.mjs')");
  const buildConfigEnd = runnerSource.indexOf("writeFile(join(params.pluginRoot, 'vite.config.mjs')", buildConfigStart + 1);
  assert.notEqual(buildConfigStart, -1, 'missing packed hosted build-config fixture');
  assert.notEqual(buildConfigEnd, -1, 'missing packed hosted build-config fixture boundary');
  const buildConfig = runnerSource.slice(buildConfigStart, buildConfigEnd);
  assert.match(buildConfig, /kind: 'hostedWeb'/u);
  assert.doesNotMatch(buildConfig, /platforms:/u);
});
