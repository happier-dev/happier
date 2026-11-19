import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { buildDeepSecLaunchEnvironment, DEEPSEC_PROVIDER_ENV_KEYS } from './providerBinding.js';

function createInput(): AgentProviderBindingMaterializeInput {
  const transport = { id: 'key', protocols: ['openai-responses'], uses: ['runtime'],
    destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
  return {
    v: 1, prepared: { v: 1, materialization: 'spawnEnv' },
    credential: { kind: 'apiKey', transport, value: 'fixture-provider-secret' },
    binding: { v: 1, agentTargetKey: 'agent:happier.review.deepsec/deepsec',
      selection: { bindingKey: 'fixture', model: { id: 'custom-model', name: 'Custom' } }, contributionKey: null,
      endpoint: { endpointTemplateId: 'responses', protocol: 'openai-responses',
        normalizedUrl: 'https://provider.example.test/codex/v1', publicHeaders: {} },
      runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:fixture' },
  };
}

describe('DeepSec native Provider constraints', () => {
  it('refuses endpoint shapes the native Codex harness would rewrite', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'deepsec')?.providerBinding;
      if (!adapter) throw new Error('Expected DeepSec Provider adapter');
      const input = createInput();
      for (const normalizedUrl of ['https://provider.example.test', 'https://provider.example.test/v2',
        'https://provider.example.test/v1?route=other', 'https://provider.example.test/v1#fragment']) {
        await expect(adapter.materialize({ ...input, binding: { ...input.binding,
          endpoint: { ...input.binding.endpoint, normalizedUrl } } })).rejects.toThrow('must end in /v1');
      }
    } finally { await activation.dispose(); }
  });

  it('refuses unsupported headers, unauthenticated routes and mismatched credential transports', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'deepsec')?.providerBinding;
      if (!adapter) throw new Error('Expected DeepSec Provider adapter');
      const input = createInput();
      await expect(adapter.materialize({ ...input, binding: { ...input.binding,
        endpoint: { ...input.binding.endpoint, publicHeaders: { 'x-team': 'coding' } } } })).rejects.toThrow('public headers');
      await expect(adapter.materialize({ ...input, credential: { kind: 'none' } })).rejects.toThrow('API key');
      await expect(adapter.materialize({ ...input, credential: { kind: 'apiKey', value: 'fixture-key',
        transport: { ...input.binding.runtimeCredentialTransport!, protocols: ['anthropic-messages'] } },
      })).rejects.toThrow('selected transport');
    } finally { await activation.dispose(); }
  });

  it('uses the host-admitted credential without rechecking its transport descriptor identity', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const adapter = activation.registration('agents', 'deepsec')?.providerBinding;
      if (!adapter) throw new Error('Expected DeepSec Provider adapter');
      const input = createInput();
      await expect(adapter.materialize({ ...input, binding: { ...input.binding,
        runtimeCredentialTransport: null }, credential: { kind: 'apiKey', value: 'fixture-key',
          transport: { ...input.binding.runtimeCredentialTransport!,
            destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } },
      })).resolves.toMatchObject({ kind: 'spawnEnv' });
    } finally { await activation.dispose(); }
  });

  it.each([
    undefined,
    { AI_GATEWAY_API_KEY: 'fixture-gateway' },
    { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-subscription', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    { OPENAI_API_KEY: 'fixture-provider', OPENAI_BASE_URL: 'https://provider.example.test/codex/v1' },
  ])('prevents repository dotenv from replacing the selected route or filling unused credential keys (%#)', async values => {
    const directory = await mkdtemp(join(tmpdir(), 'deepsec-dotenv-'));
    try {
      const path = join(directory, '.env');
      await writeFile(path, DEEPSEC_PROVIDER_ENV_KEYS.map(name => `${name}=https://attacker.example.test`).join('\n'));
      const selected: Readonly<Record<string, string>> = values ?? {};
      const environment = buildDeepSecLaunchEnvironment(selected);
      const { stdout } = await promisify(execFile)(process.execPath, ['-e',
        'const before = {...process.env}; process.loadEnvFile(process.argv[1]); console.log(JSON.stringify(Object.keys(before).every(key => process.env[key] === before[key])))', path],
      { env: environment });
      expect(stdout.trim()).toBe('true');
      expect(Object.keys(environment).sort()).toEqual([...DEEPSEC_PROVIDER_ENV_KEYS].sort());
      for (const name of DEEPSEC_PROVIDER_ENV_KEYS) expect(environment[name]).toBe(selected[name] ?? '');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
