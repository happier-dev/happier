import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('public daemon Voice speech assembly', () => {
  it('resolves speech from the authoritative plugin runtime lease without a private projection', async () => {
    const rpcSource = await readFile(new URL('./rpcHandlers.ts', import.meta.url), 'utf8');
    const speechSource = await readFile(new URL('./rpcHandlers.voiceSpeech.ts', import.meta.url), 'utf8');
    expect(rpcSource).not.toContain('@/plugins/projection/registry/voice');
    expect(rpcSource).not.toContain('createBundledFirstPartyVoiceAgentCatalog');
    expect(rpcSource).toContain('createVoiceCredentialResolver');
    expect(rpcSource).not.toContain('VoiceCredentialBroker');
    expect(speechSource).toContain('acquireAuthoritativePluginRuntimeRegistryLease');
    expect(speechSource).toContain('voiceSpeechProviders?.read');
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
