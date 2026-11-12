import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, PLUGIN_MANIFEST } from '@happier-dev/plugins-qwen';
import { describe, expect, it } from 'vitest';

import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { composeProviderBindingMaterialization } from './compose';

describe('registered Qwen Provider settings', () => {
  it('delivers Responses settings through the native override while preserving the native home and runtime state', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-qwen-provider-settings-'));
    const native = join(base, 'native');
    const runtimeRoot = join(base, 'runtime');
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
    let cleanup: (() => void) | null = null;
    try {
      await mkdir(native, { recursive: true });
      await mkdir(join(runtimeRoot, 'projects/workspace/chats'), { recursive: true });
      await writeFile(join(runtimeRoot, 'projects/workspace/chats/native-session.jsonl'), 'native-history');
      await writeFile(join(native, 'settings.json'), JSON.stringify({ ui: { theme: 'dark' } }));
      await writeFile(join(native, 'oauth_creds.json'), 'native-auth-fixture');
      const agent = activation.registration('agents', 'qwen');
      const declaration = PLUGIN_MANIFEST.contributes.agents.find(row => row.id === 'qwen');
      if (!agent?.providerBinding || !agent.factory || !declaration) throw new Error('Expected registered Qwen runtime and Provider adapter');
      const model = { id: 'selected-model', name: 'Selected model' };
      const transport = { id: 'fixture-runtime', protocols: ['openai-responses'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } } as const;
      const materialization = await agent.providerBinding.materialize({ v: 1,
        prepared: agent.providerBinding.prepare({ v: 1, connectionId: 'pc_qwen', agentTargetKey: 'agent:happier.agent.qwen/qwen' }),
        binding: { v: 1, agentTargetKey: 'agent:happier.agent.qwen/qwen', contributionKey: null,
          selection: { connectionId: 'pc_qwen', model },
          endpoint: { endpointTemplateId: 'custom', normalizedUrl: 'https://provider.example/v1', protocol: 'openai-responses', publicHeaders: { 'X-Project': 'Happier' } },
          runtimeCredentialTransport: transport, compatibilityFingerprint: 'pcf1:qwen-native-settings' },
        credential: { kind: 'apiKey', transport, value: 'selected-provider-fixture' } });
      const composed = await composeProviderBindingMaterialization({ materialization, materializationBaseDir: join(base, 'materialized') });
      cleanup = composed.cleanup;
      if (composed.launchMaterialization.kind !== 'configFile') throw new Error('Expected Qwen settings file');
      fixture = createAcpMcpPolicyFixture({ agent: declaration, pluginId: PLUGIN_MANIFEST.id,
        async factory(context) {
          const runtime = await agent.factory!(context);
          return { ...runtime, sessions: { ...runtime.sessions, open(request, host) {
            return runtime.sessions!.open({ ...request, launchEnvironment: {
              values: { ...request.launchEnvironment?.values, QWEN_HOME: native, QWEN_RUNTIME_DIR: runtimeRoot,
                HAPPIER_QWEN_PROVIDER_API_KEY: 'selected-provider-fixture' },
              unset: request.launchEnvironment?.unset.filter(key => !['QWEN_HOME', 'QWEN_RUNTIME_DIR', 'HAPPIER_QWEN_PROVIDER_API_KEY'].includes(key)) ?? [],
            } }, host);
          } } };
        },
      });
      await fixture.fixtureServer.prepare({ cwd: base });
      const session = await fixture.openSession({ kind: 'create', sessionId: 'provider', cwd: base,
        providerBinding: { connectionId: 'pc_qwen', model,
          upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example/v1', credential: 'apiKey' },
          materialization: composed.launchMaterialization },
        configuration: { model: { value: model.id, updatedAtMs: 1, selectionSource: 'explicit' },
          mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
      });
      try {
        const launch = fixture.observeLaunch();
        expect(launch.env.QWEN_HOME).toBe(native);
        expect(launch.env.QWEN_RUNTIME_DIR).toBe(runtimeRoot);
        expect(launch.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(join(composed.launchMaterialization.rootPath, 'settings.json'));
        const settings = await readFile(launch.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, 'utf8');
        expect(JSON.parse(settings).modelProviders.openai).toEqual([expect.objectContaining({ id: model.id, wireApi: 'responses',
          generationConfig: { customHeaders: { 'X-Project': 'Happier' } } })]);
        expect(settings).not.toContain('selected-provider-fixture');
        await expect(stat(join(composed.launchMaterialization.rootPath, 'oauth_creds.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(join(launch.env.QWEN_HOME!, 'memory.md'), 'new-native-memory');
      } finally { await session.dispose(); }
      cleanup?.(); cleanup = null;
      expect(await readFile(join(native, 'settings.json'), 'utf8')).toBe(JSON.stringify({ ui: { theme: 'dark' } }));
      expect(await readFile(join(native, 'oauth_creds.json'), 'utf8')).toBe('native-auth-fixture');
      expect(await readFile(join(native, 'memory.md'), 'utf8')).toBe('new-native-memory');
      expect(await readFile(join(runtimeRoot, 'projects/workspace/chats/native-session.jsonl'), 'utf8')).toBe('native-history');
    } finally { cleanup?.(); await fixture?.fixtureServer.dispose(); await activation.dispose(); await rm(base, { recursive: true, force: true }); }
  });
});
