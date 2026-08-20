import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OUTPUT_PATH, collectStability, renderAgentReferenceMarkdown } from './generateAgentReference.mjs';

const AGENTS_DIST = join(
  import.meta.dirname, '..', '..', '..', 'packages', 'agents', 'dist', 'index.js',
);

test('the published capability reference matches what the manifest renders', { skip: !existsSync(AGENTS_DIST) && 'packages/agents is not built' }, async () => {
  const rendered = await renderAgentReferenceMarkdown();
  const published = readFileSync(OUTPUT_PATH, 'utf8');

  assert.equal(
    published,
    rendered,
    'providers/capabilities.mdx is stale. Run `yarn --cwd apps/docs generate:reference`.',
  );
});

test('every agent has a stability marker, or generation fails loudly', () => {
  const providersDir = mkdtempSync(join(tmpdir(), 'agent-stability-'));
  for (const [id, experimental] of [['claude', 'false'], ['grok', 'true']]) {
    mkdirSync(join(providersDir, id), { recursive: true });
    writeFileSync(
      join(providersDir, id, 'core.ts'),
      `export const core = {\n  availability: {\n    experimental: ${experimental},\n  },\n};\n`,
      'utf8',
    );
  }

  assert.deepEqual(
    collectStability({ providersDir, agentIds: ['claude', 'grok'] }),
    { claude: 'Stable', grok: 'Experimental' },
  );

  // A new agent with no UI core directory must not silently render as Stable.
  assert.throws(
    () => collectStability({ providersDir, agentIds: ['claude', 'newcomer'] }),
    /No UI core directory for agent "newcomer"/,
  );
});

test('a core file whose shape changed fails rather than guessing', () => {
  const providersDir = mkdtempSync(join(tmpdir(), 'agent-stability-'));
  mkdirSync(join(providersDir, 'claude'), { recursive: true });
  writeFileSync(join(providersDir, 'claude', 'core.ts'), 'export const core = { id: "claude" };\n', 'utf8');

  assert.throws(
    () => collectStability({ providersDir, agentIds: ['claude'] }),
    /Could not read availability\.experimental for agent "claude"/,
  );
});
