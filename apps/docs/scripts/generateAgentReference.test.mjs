import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OUTPUT_PATH,
  collectDisplayNames,
  collectStability,
  renderAgentReferenceMarkdown,
  toolsCell,
} from './generateAgentReference.mjs';

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

test('display names come from the client catalog, not a copy kept in this file', () => {
  // The hand-written map this replaced knew about fifteen agents. Three more shipped, and the
  // published page rendered them as `agy`, `fx` and `droid` while the app showed their real names.
  const providersDir = mkdtempSync(join(tmpdir(), 'agent-names-'));
  for (const id of ['claude', 'droid']) {
    mkdirSync(join(providersDir, id), { recursive: true });
    writeFileSync(
      join(providersDir, id, 'core.ts'),
      `export const core = {\n    displayNameKey: 'agentInput.agent.${id}',\n};\n`,
      'utf8',
    );
  }
  const translationsPath = join(providersDir, 'en.ts');
  writeFileSync(
    translationsPath,
    [
      'const extension = {',
      "    unrelated: { droid: 'Not the agent name' },",
      '};',
      'export const en = {',
      '    // A closing brace in a comment: }',
      '    agentInput: {',
      '        // A comment with a stray { brace and an apostrophe: don\'t desync.',
      '        /* Another closing brace in a comment: } */',
      '        permissionMode: { droid: "Wrong parent" },',
      '        agent: {',
      "            claude: 'Claude',",
      '            droid: "Factory Droid",',
      '        },',
      '    },',
      '};',
    ].join('\n'),
    'utf8',
  );

  assert.deepEqual(
    collectDisplayNames({ providersDir, bundlePath: '/none', translationsPath, agentIds: ['claude', 'droid'] }),
    { claude: 'Claude', droid: 'Factory Droid' },
  );

  // An agent whose name cannot be resolved must fail generation rather than publish its raw id.
  assert.throws(
    () => collectDisplayNames({ providersDir, bundlePath: '/none', translationsPath, agentIds: ['claude', 'newcomer'] }),
    /Could not resolve a display name for: newcomer/,
  );
});

test('display names also resolve through the generated plugin bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-name-bundle-'));
  writeFileSync(
    join(dir, 'generatedBundledPluginEntries.ts'),
    [
      'const GROK_CORE: AgentCoreConfig = {',
      "    id: 'grok',",
      "    displayNameKey: 'agentInput.agent.grok',",
      '};',
    ].join('\n'),
    'utf8',
  );
  const translationsPath = join(dir, 'en.ts');
  writeFileSync(
    translationsPath,
    "export const en = {\n    agentInput: {\n        agent: {\n            grok: 'Grok',\n        },\n    },\n};\n",
    'utf8',
  );

  assert.deepEqual(
    collectDisplayNames({
      providersDir: '/none',
      bundlePath: join(dir, 'generatedBundledPluginEntries.ts'),
      translationsPath,
      agentIds: ['grok'],
    }),
    { grok: 'Grok' },
  );
});

test('tool support preserves experimental native MCP declarations', () => {
  assert.equal(toolsCell({ delivery: 'native_mcp', support: 'supported' }), 'Yes (`native_mcp`)');
  assert.equal(toolsCell({ delivery: 'native_mcp', support: 'experimental' }), 'Experimental (`native_mcp`)');
  assert.equal(toolsCell({ delivery: 'unsupported', support: 'unsupported' }), '—');
});

test('negotiated session modes leave Plan availability to advertised choices', {
  skip: !existsSync(AGENTS_DIST) && 'packages/agents is not built',
}, async () => {
  const agents = await import(`file://${AGENTS_DIST}`);
  const rendered = await renderAgentReferenceMarkdown();
  const names = collectDisplayNames({ agentIds: agents.AGENT_IDS });
  const runningTurn = rendered.split('## Running a turn\n')[1].split('## Media and tools')[0];
  const rows = new Map(runningTurn.split('\n')
    .filter((line) => line.startsWith('| **'))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return [cells[0], cells];
    }));
  for (const id of agents.AGENT_IDS) {
    if (agents.getAgentSessionModeDescriptor(id).source !== 'acp') continue;
    assert.equal(rows.get(`**${names[id]}**`)[3], 'Runtime-dependent', `${id} cannot establish an advertised Plan choice from its mode descriptor`);
  }
  assert.equal(rows.get(`**${names.claude}**`)[3], 'Yes');
  assert.equal(rows.get(`**${names.codex}**`)[2], 'Policy presets, from the agent');
});
