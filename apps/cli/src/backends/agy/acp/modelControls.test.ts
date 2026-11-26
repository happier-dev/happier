import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { resolveExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendRegistry';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createAgyAcpBackend } from './backend';
import { resolveAgySessionConfigOptionUpdate, resolveAgySessionModelConfigUpdate } from './modelControls';

const level = (value: string, name: string) => ({ value, name });
/** `session/new` controls as `agy acp` 1.5.18 advertises them (trimmed to three families). */
const NATIVE_CONFIG_OPTIONS = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [
    { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ] },
  { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'high', options: [
    level('low', 'Low'), level('medium', 'Medium'), level('high', 'High'), level('xhigh', 'Extra'),
  ] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [level('default', 'Default'), level('plan', 'Plan')] },
] satisfies SessionConfigOption[];
const LEGACY_MODELS = {
  currentModelId: 'gemini-4-neon-high',
  availableModels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ modelId: `gemini-4-neon-${effort}`, name: `Gemini 4 Neon (${effort})` })),
};

async function writeAgyFixture(dir: string): Promise<string> {
  const script = writeAcpTestAgentScript({ dir, fileName: 'agy', source: `#!${process.execPath}
    const fs = require('node:fs');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method?.startsWith('session/set_')) fs.appendFileSync(${JSON.stringify(join(dir, 'controls.jsonl'))}, JSON.stringify({ method: request.method, params: request.params }) + '\\n');
      const result = request.method === 'initialize' ? { protocolVersion: 1, agentInfo: { version: '1.5.18' } }
        : request.method === 'session/new' ? { sessionId: 'new-session', models: ${JSON.stringify(LEGACY_MODELS)}, configOptions: ${JSON.stringify(NATIVE_CONFIG_OPTIONS)} }
        : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  ` });
  await chmod(script, 0o755);
  return script;
}

describe.skipIf(process.platform === 'win32')('Antigravity model controls', () => {
  it('offers model families with the effort control instead of one model per effort', async () => {
    await withTempDir('agy-models-', async dir => {
      const backend = await createAgyAcpBackend({ cwd: dir, env: { HAPPIER_AGY_PATH: await writeAgyFixture(dir) } });
      try {
        await backend.startSession();
        const state = (backend as unknown as { getSessionModelState(): unknown }).getSessionModelState();
        expect(state).toMatchObject({
          currentModelId: 'gemini-4-neon',
          availableModels: [
            { id: 'gemini-4-neon', name: 'Gemini 4 Neon', modelOptions: [{ id: 'thought_level', currentValue: 'high' }] },
            { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
            { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
          ],
        });
      } finally { await backend.dispose(); }
    });
  });

  it('applies a saved effort-suffixed execution-run model as family plus effort', async () => {
    await withTempDir('agy-models-', async dir => {
      const factory = resolveExecutionRunBackendFactory('agy');
      if (!factory) throw new Error('Expected the agy execution-run backend');
      const backend = factory({
        cwd: dir, backendId: 'agy', modelId: 'gemini-4-neon-medium', permissionMode: 'default',
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
        isolation: { env: { HAPPIER_AGY_PATH: await writeAgyFixture(dir) } },
      });
      try {
        await backend.startSession();
        const controls = (await readFile(join(dir, 'controls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(controls).toEqual([
          { method: 'session/set_config_option', params: { sessionId: 'new-session', configId: 'model', value: 'gemini-4-neon' } },
          { method: 'session/set_config_option', params: { sessionId: 'new-session', configId: 'thought_level', value: 'medium' } },
        ]);
      } finally { await backend.dispose(); }
    });
  });
});

describe('Antigravity saved model and effort mapping', () => {
  it.each([
    { modelId: 'gemini-4-neon', expected: { modelId: 'gemini-4-neon' } },
    { modelId: 'gemini-4-neon-xhigh', expected: { modelId: 'gemini-4-neon', configUpdates: [{ configId: 'thought_level', value: 'xhigh' }] } },
    // A family whose own id ends like an effort stays that family.
    { modelId: 'gpt-oss-120b-medium', expected: { modelId: 'gpt-oss-120b-medium' } },
    { modelId: 'unknown-model', expected: { modelId: 'unknown-model' } },
  ])('maps $modelId', ({ modelId, expected }) => {
    expect(resolveAgySessionModelConfigUpdate({ modelId, configOptions: NATIVE_CONFIG_OPTIONS })).toEqual(expected);
  });

  it('applies the provider-neutral reasoning effort as the native thought level', () => {
    expect(resolveAgySessionConfigOptionUpdate({ configId: 'reasoning_effort', value: 'low', configOptions: NATIVE_CONFIG_OPTIONS }))
      .toEqual({ configId: 'thought_level', value: 'low' });
    expect(resolveAgySessionConfigOptionUpdate({ configId: 'mode', value: 'plan', configOptions: NATIVE_CONFIG_OPTIONS }))
      .toEqual({ configId: 'mode', value: 'plan' });
  });
});
