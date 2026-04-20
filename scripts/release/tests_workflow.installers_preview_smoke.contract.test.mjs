import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow can smoke-test preview installers when requested', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(raw, /installers_channel:/, 'tests.yml should expose installers_channel input');
  assert.match(raw, /node scripts\/pipeline\/run\.mjs release-validate/, 'tests.yml should delegate installer smoke to release-validate');
  assert.match(raw, /--suite installers-smoke/, 'tests.yml should run the installer smoke suite');
  assert.match(raw, /INSTALLERS_SOURCE:/, 'tests.yml should route installer source selection through env');
  assert.match(raw, /INSTALLERS_REF:/, 'tests.yml should route installer refs through env');
  assert.match(raw, /INSTALLERS_RELEASE_CHANNEL:/, 'tests.yml should route installer release channels through env');
  assert.match(raw, /--source "\$\{INSTALLERS_SOURCE\}"|--source "\$env:INSTALLERS_SOURCE"/, 'tests.yml should pass the resolved installer source into release-validate');
  assert.match(raw, /--ref "\$\{INSTALLERS_REF\}"|--ref "\$env:INSTALLERS_REF"/, 'tests.yml should pass the resolved installer ref into release-validate');
  assert.match(raw, /--release-channel "\$\{INSTALLERS_RELEASE_CHANNEL\}"|--release-channel "\$env:INSTALLERS_RELEASE_CHANNEL"/, 'tests.yml should pass the resolved installer release channel into release-validate');
  assert.match(
    raw,
    /INSTALLERS_CHANNEL:\s*\$\{\{\s*\(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'workflow_call'\)\s*&&\s*inputs\.installers_channel\s*\|\|\s*\(\(github\.event_name == 'push' && github\.ref_name == 'main'\) \|\| \(github\.event_name == 'pull_request' && github\.base_ref == 'main'\)\)\s*&&\s*'stable'\s*\|\|\s*'preview'\s*\}\}/,
    'tests.yml should default installer smoke to preview outside the main production lane',
  );
  assert.match(
    raw,
    /INSTALLERS_SOURCE:\s*\$\{\{\s*\(\(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'workflow_call'\) \|\| \(\(github\.event_name == 'push' && github\.ref_name == 'main'\) \|\| \(github\.event_name == 'pull_request' && github\.base_ref == 'main'\)\)\)\s*&&\s*'published-channel'\s*\|\|\s*'local-build'\s*\}\}/,
    'tests.yml should validate non-production branch installs from local-build assets while preserving published-channel callers',
  );
  assert.match(
    raw,
    /INSTALLERS_REF:\s*\$\{\{\s*\(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'workflow_call'\)\s*&&\s*inputs\.installers_channel\s*\|\|\s*\(\(github\.event_name == 'push' && github\.ref_name == 'main'\) \|\| \(github\.event_name == 'pull_request' && github\.base_ref == 'main'\)\)\s*&&\s*'stable'\s*\|\|\s*'\.'\s*\}\}/,
    'tests.yml should use the repo local-build ref outside published installer lanes',
  );
  assert.doesNotMatch(raw, /cli-preview/, 'tests.yml should not own rolling release tag names directly');
  assert.doesNotMatch(raw, /install-preview\.(sh|ps1)/, 'tests.yml should not own installer filename selection directly');
});
