import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('./run-hosted-web-bridge-browser-qa.mjs', import.meta.url);

test('hosted-web bridge browser QA sends launch and runtime facts only after guest readiness', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  for (const queryFact of [
    'happierPluginVersion',
    'happierViewId',
    'happierGeneration',
    'happierSubPath',
    'happierLaunchInput',
  ]) {
    assert.equal(
      source.includes(`url.searchParams.set('${queryFact}'`),
      false,
      `${queryFact} must not be injected into the frame URL`,
    );
  }

  assert.match(source, /bootstrap:\s*\{[\s\S]*frameOrigin:\s*assetOrigin[\s\S]*subPath:\s*'work\/ideas\.md'[\s\S]*launchInput:\s*\{ noteId:\s*'note-7' \}/u);
  assert.match(source, /launch and runtime facts are absent from the frame URL/u);
});

test('hosted-web bridge browser QA supplies the canonical app-page container to the public client', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  // The snapshot the QA hands the public client must carry the canonical destination mount, and
  // the assertion must read the container back off that mount. `placement` is the retired flat
  // field: a QA that reverted to it would stop exercising the shape the client actually negotiates.
  assert.match(
    source,
    /function surfaceSnapshot\(overrides = \{\}\) \{\s+return \{\s+mount: \{\s+kind: 'destination',\s+destination: \{[^{}]*\},\s+container: 'appPage',\s+\},/u,
  );
  assert.doesNotMatch(source, /function surfaceSnapshot\(overrides = \{\}\) \{\s+return \{\s+placement:/u);
  assert.match(source, /observed\.mountcontainer === 'appPage'/u);
});

test('hosted-web bridge browser QA keeps generated bundle entries out of the shared worktree', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  assert.doesNotMatch(source, /join\(repoRoot, 'packages\/tests\/\.eu8-(?:guest|host|node)-entry\.mjs'\)/u);
  for (const entryName of ['guest-entry.mjs', 'host-entry.mjs', 'node-entry.mjs']) {
    assert.match(source, new RegExp(`join\\(workspace, '${entryName.replace('.', '\\.')}'\\)`, 'u'));
  }
  assert.match(source, /nodePaths:\s*\[join\(repoRoot, 'node_modules'\)\]/u);
});
