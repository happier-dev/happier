import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OUTPUT_PATH, collectStability, renderAgentReferenceMarkdown } from './generateAgentReference.mjs';

const AGENTS_DIST = join(
  import.meta.dirname, '..', '..', '..', 'packages', 'agents', 'dist', 'index.js',
);

/**
 * Drift only. Whether the page *exists* is `checkGeneratedPages`' job — it
 * reports a missing generated page as a content problem. Asserting existence
 * here too would make the ported mechanism fail in a tree that has the
 * generators but has not yet published their output.
 */
test('the published capability reference matches what the manifest renders', {
  skip:
    (!existsSync(AGENTS_DIST) && 'packages/agents is not built') ||
    (!existsSync(OUTPUT_PATH) && 'the reference has not been generated in this tree yet'),
}, async () => {
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
    collectStability({ providersDir, bundlePath: '/none', agentIds: ['claude', 'grok'] }),
    { claude: 'Stable', grok: 'Experimental' },
  );

  // A new agent with no entry in either layout must not silently render as Stable.
  assert.throws(
    () => collectStability({ providersDir, bundlePath: '/none', agentIds: ['claude', 'newcomer'] }),
    /Could not read availability\.experimental for: newcomer/,
  );
});

test('a core file whose shape changed fails rather than guessing', () => {
  const providersDir = mkdtempSync(join(tmpdir(), 'agent-stability-'));
  mkdirSync(join(providersDir, 'claude'), { recursive: true });
  writeFileSync(join(providersDir, 'claude', 'core.ts'), 'export const core = { id: "claude" };\n', 'utf8');

  assert.throws(
    () => collectStability({ providersDir, bundlePath: '/none', agentIds: ['claude'] }),
    /Could not read availability\.experimental for: claude/,
  );
});

test('reads stability from the single generated bundle when agents are plugins', () => {
  // The v0.3 layout: every agent's core config is emitted into one file rather
  // than one module per agent, so the generator has to understand both.
  const dir = mkdtempSync(join(tmpdir(), 'agent-bundle-'));
  writeFileSync(
    join(dir, 'generatedBundledPluginEntries.ts'),
    [
      "const CLAUDE_CORE: AgentCoreConfig = {",
      "    id: 'claude',",
      "    displayNameKey: 'agentInput.agent.claude',",
      "    availability: { experimental: false },",
      "};",
      "const GROK_CORE: AgentCoreConfig = {",
      "    id: 'grok',",
      "    displayNameKey: 'agentInput.agent.grok',",
      "    availability: { experimental: true },",
      "};",
    ].join('\n'),
    'utf8',
  );

  assert.deepEqual(
    collectStability({
      providersDir: '/none',
      bundlePath: join(dir, 'generatedBundledPluginEntries.ts'),
      agentIds: ['claude', 'grok'],
    }),
    { claude: 'Stable', grok: 'Experimental' },
  );
});
