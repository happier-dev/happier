import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('declares one custom Session Agent with its import-safe runner leaf', async () => {
  const compiledEntry = new URL('../dist/index.js', import.meta.url);
  try {
    await access(compiledEntry);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
    // The SDK repository runs adjacent example tests against source without
    // materializing every example's dist. A copied scaffold's managed
    // `plugins test` path builds first and therefore takes the runtime branch
    // below; this source fallback keeps the repository lane executable too.
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
    assert.match(source, /primary: 'sessions'/u);
    assert.match(source, /open: \['create', 'resume'\]/u);
    assert.match(source, /sessionRunnerFactory:\s*\{/u);
    assert.match(source, /export: 'createDeterministicSessionAgentRuntime'/u);
    return;
  }

  const module = await import(compiledEntry.href);
  assert.equal(module.manifest.contributes.agents.length, 1);
  const [agent] = module.manifest.contributes.agents;
  assert.equal(agent.runtime.kind, 'custom');
  assert.equal(agent.primary, 'sessions');
  assert.deepEqual(agent.capabilities.sessions.open, ['create', 'resume']);
  assert.equal(agent.sessionRunnerFactory.export, 'createDeterministicSessionAgentRuntime');
  assert.equal(agent.sessionRunnerFactory.runtimeApiVersion, 1);
});
