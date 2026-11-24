import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { buildDeepSecLaunchEnvironment, DEEPSEC_PROVIDER_ENV_KEYS, readDeepSecProviderLaunch, resolveDeepSecProviderRoute } from './providerBinding.js';

describe('DeepSec native Provider constraints', () => {
  it('refuses endpoint shapes the native Codex harness would rewrite', () => {
    for (const normalizedUrl of ['https://provider.example.test', 'https://provider.example.test/v2',
      'https://provider.example.test/v1?route=other', 'https://provider.example.test/v1#fragment']) {
      expect(() => resolveDeepSecProviderRoute({ protocol: 'openai-responses', normalizedUrl, model: 'selected' }))
        .toThrow('must end in /v1');
    }
  });

  it('refuses Codex custom headers that the DeepSec SDK cannot forward', () => {
    expect(() => readDeepSecProviderLaunch({ connectionId: 'selected', model: { id: 'selected', name: 'Selected' },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example.test/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig: { modelProvider: 'selected', config: {
        'model_providers.selected': { env_key: 'HOST_KEY', http_headers: { 'x-custom': 'required' } },
      } } },
    }, { values: { HOST_KEY: 'secret' }, unset: [] })).toThrow('cannot preserve');
  });

  it('preserves the selected Claude Provider endpoint and environment without exposing its bearer in argv', () => {
    const launch = readDeepSecProviderLaunch({ connectionId: 'selected', model: { id: 'selected', name: 'Selected' },
      upstream: { protocol: 'anthropic', normalizedUrl: 'https://provider.example.test', credential: 'apiKey' },
      materialization: { v: 1, kind: 'spawnEnv' },
    }, { values: { ANTHROPIC_AUTH_TOKEN: 'host-token', CLAUDE_CONFIG_DIR: '/host/claude' }, unset: [] });
    expect(launch.route).toEqual({ agent: 'claude', provider: 'anthropic', baseUrl: 'https://provider.example.test', model: 'selected' });
    expect(launch.environment).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'host-token', OPENAI_API_KEY: '', CLAUDE_CONFIG_DIR: '/host/claude' });
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
