import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const workflowsDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

test('workflow runner images use explicit versions, including matrices and dynamic mappings', async () => {
  const floating = [];
  function inspect(value, location) {
    if (typeof value === 'string') {
      // Inspect scalar contents too: expressions and shell-written runner outputs
      // can choose an image indirectly. Artifact flags such as make-latest are unrelated.
      const labels = value.match(/\b(?:ubuntu|windows|macos)-latest(?:-[\w.-]+)?\b/gu) ?? [];
      if (location.includes('.runs-on')) {
        labels.push(...(value.match(/\b[\w.-]+-latest\b/gu) ?? []));
      }
      for (const label of new Set(labels)) floating.push(`${location}: ${label}`);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${location}[${index}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) inspect(entry, `${location}.${key}`);
    }
  }
  for (const name of (await readdir(workflowsDir)).filter((entry) => /\.ya?ml$/u.test(entry)).sort()) {
    inspect(YAML.parse(await readFile(new URL(name, new URL('../../.github/workflows/', import.meta.url)), 'utf8')), name);
  }
  assert.deepEqual(floating, [], `Pin runner images deliberately instead of following -latest:\n${floating.join('\n')}`);
});
