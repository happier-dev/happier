import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow exposes a thin docker release-assets job through release-validate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /run_release_assets_docker:\n\s+required: false\n\s+default: false\n\s+type: boolean/,
    'tests workflow should expose a dedicated workflow_call input for the Docker release-assets lane',
  );

  assert.match(
    raw,
    /release-assets-docker:[\s\S]*?ref: \$\{\{ inputs\.checkout_sha != '' && inputs\.checkout_sha \|\| github\.sha \}\}/,
    'release-assets-docker should check out the exact candidate SHA',
  );
  assert.match(raw, /release-assets-docker:[\s\S]*?test "\$\(git rev-parse HEAD\)" = "\$CHECKOUT_SHA"/);
  assert.match(
    raw,
    /release-assets-docker:[\s\S]*?--suite docker-release-assets \\\n[\s\S]*?--platform linux \\\n[\s\S]*?--from-source published-channel \\\n[\s\S]*?--from-ref "\$\{INSTALLERS_CHANNEL\}" \\\n[\s\S]*?--to-source local-build \\\n[\s\S]*?--to-ref "\."/,
    'release-assets-docker should upgrade the selected published predecessor to the exact candidate checkout',
  );
});
