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
    const options = ${JSON.stringify(NATIVE_CONFIG_OPTIONS)};
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method?.startsWith('session/set_')) fs.appendFileSync(${JSON.stringify(join(dir, 'controls.jsonl'))}, JSON.stringify({ method: request.method, params: request.params }) + '\\n');
      // Like agy, a model switch narrows the advertised thought levels to that model's (Flash: low..high).
      if (request.method === 'session/set_config_option' && request.params.configId === 'model') {
        options[0] = { ...options[0], currentValue: request.params.value };
        const levels = request.params.value === 'gemini-3.8-flash' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh'];
        options[1] = { ...options[1], options: levels.map(value => ({ value, name: value })) };
      }
      if (request.method === 'session/set_config_option' && request.params.configId === 'thought_level') {
        if (!options[1].options.some(option => option.value === request.params.value)) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'unsupported thought level' } }) + '\\n');
          return;
        }
        options[1] = { ...options[1], currentValue: request.params.value };
      }
      const result = request.method === 'initialize' ? { protocolVersion: 1, agentInfo: { version: '1.5.18' } }
        : request.method === 'session/new' ? { sessionId: 'new-session', models: ${JSON.stringify(LEGACY_MODELS)}, configOptions: options }
        : request.method === 'session/set_config_option' ? { configOptions: options }
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

  it.each([
    { modelId: 'gemini-4-neon-medium', applied: [['model', 'gemini-4-neon'], ['thought_level', 'medium']] },
    // The effort is validated against the switched model's levels; an unoffered one keeps the current effort.
    { modelId: 'gemini-3.8-flash-low', applied: [['model', 'gemini-3.8-flash'], ['thought_level', 'low']] },
    { modelId: 'gemini-3.8-flash-xhigh', applied: [['model', 'gemini-3.8-flash']] },
  ])('applies the saved effort-suffixed execution-run model $modelId as family plus an offered effort', async ({ modelId, applied }) => {
    await withTempDir('agy-models-', async dir => {
      const factory = resolveExecutionRunBackendFactory('agy');
      if (!factory) throw new Error('Expected the agy execution-run backend');
      const backend = factory({
        cwd: dir, backendId: 'agy', modelId, permissionMode: 'default',
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
        isolation: { env: { HAPPIER_AGY_PATH: await writeAgyFixture(dir) } },
      });
      try {
        await backend.startSession();
        const controls = (await readFile(join(dir, 'controls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(controls.filter(control => control.method === 'session/set_config_option')
          .map(control => [control.params.configId, control.params.value])).toEqual(applied);
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
