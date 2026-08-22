import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';

describe('public daemon Voice speech assembly', () => {
  it('projects the executable OpenAI-compatible STT/TTS leaves through the ordinary bundled daemon boundary', () => {
    const contributions = resolveBuiltInContributions();
    const activation = contributions.activationTargets?.find(
      (candidate) => candidate.pluginId === 'happier.voice.openai-compat',
    );
    expect(activation?.daemonEntryPath).toBe('@happier-dev/plugins-openai-compat');
    expect(contributions.voiceProviders?.filter(
      (candidate) => candidate.pluginId === 'happier.voice.openai-compat',
    ).map((candidate) => candidate.definition.id)).toEqual(['stt', 'tts']);
  });

  it('resolves speech from the authoritative plugin runtime lease without a private projection', async () => {
    const rpcSource = await readFile(new URL('./rpcHandlers.ts', import.meta.url), 'utf8');
    const speechSource = await readFile(new URL('./rpcHandlers.voiceSpeech.ts', import.meta.url), 'utf8');
    expect(rpcSource).not.toContain('@/plugins/projection/registry/voice');
    expect(rpcSource).not.toContain('createBundledFirstPartyVoiceAgentCatalog');
    expect(rpcSource).not.toContain('createVoiceCredentialResolver');
    expect(rpcSource).not.toContain('VoiceCredentialBroker');
    expect(speechSource).toContain('acquireAuthoritativePluginRuntimeRegistryLease');
    expect(speechSource).toContain('voiceSpeechProviders?.read');
    expect(speechSource).toContain('createDaemonPluginRawCredentialMaterializer');
  });

  it('routes each raw Voice credential entry point through the one daemon materializer composition', async () => {
    const rawClientSource = await readFile(
      new URL('./rpcHandlers.voiceClientCredentials.ts', import.meta.url),
      'utf8',
    );
    const authorizationSource = await readFile(
      new URL('./rpcHandlers.voiceClientCredentialAuthorization.ts', import.meta.url),
      'utf8',
    );
    const speechSource = await readFile(
      new URL('./rpcHandlers.voiceSpeech.ts', import.meta.url),
      'utf8',
    );

    for (const source of [rawClientSource, authorizationSource, speechSource]) {
      expect(source).toContain('createDaemonPluginRawCredentialMaterializer');
      expect(source).not.toContain('createPluginRawCredentialMaterializer');
      expect(source).not.toContain('createPluginRawCredentialAuthorizationInspector');
      expect(source).not.toContain('createRegistryInstallReviewPrincipalReader');
    }
    for (const source of [rawClientSource, speechSource]) {
      expect(source).not.toContain('createServerPluginPermissionGrantListReader');
    }
    for (const source of [rawClientSource, authorizationSource]) {
      expect(source).not.toContain('warmActiveAccountSettingsSnapshotBestEffort');
    }
    // Speech has to load settings before it can construct an invocation-bound
    // credential access object; that read is intentionally earlier than raw
    // materialization, but it uses the canonical settings warmer.
    expect(speechSource).toContain('warmActiveAccountSettingsSnapshotBestEffort');
  });

  it('keeps vendor package imports inside the generated first-party projection boundary', async () => {
    const root = new URL('../../', import.meta.url);
    const generatedProjectionBoundary = new URL(
      'plugins/projection/registry/sources/generatedBundledPlugins.ts',
      root,
    );
    const files: URL[] = [];
    const visit = async (directory: URL): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) await visit(child);
        else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name)) files.push(child);
      }
    };
    await visit(root);

    const violations: string[] = [];
    for (const file of files) {
      if (file.href === generatedProjectionBoundary.href) continue;
      const source = await readFile(file, 'utf8');
      if (
        source.includes('@happier-dev/plugins-elevenlabs/')
        || source.includes('@happier-dev/plugins-google/')
        || source.includes('@happier-dev/plugins-openai/')
        || source.includes('@happier-dev/plugins-xai/')
      ) {
        violations.push(file.pathname.slice(root.pathname.length));
      }
    }
    expect(violations).toEqual([]);
  });
});
