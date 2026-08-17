import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('definePlugin browser graph', () => {
  it('loads attachment runtime registration fields from the browser-safe Protocol entry', async () => {
    const workspaceRequire = createRequire(resolve(import.meta.dirname, '../../package.json'));
    const protocol = await import(pathToFileURL(workspaceRequire.resolve(
      '@happier-dev/protocol/plugins/contributions/composer-attachments',
    )).href);

    expect(protocol.COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1).toEqual([
      'prepareForSend',
      'resolveForDispatch',
      'afterMessageAccepted',
    ]);
  });

  it('keeps manifest authoring validation out of Collection encryption/runtime modules', async () => {
    const sdkEntry = resolve(import.meta.dirname, './definePlugin.ts');
    const protocolManifestEntry = resolve(
      import.meta.dirname,
      '../../protocol/src/plugins/manifest/index.ts',
    );
    const protocolComposerAttachmentsEntry = resolve(
      import.meta.dirname,
      '../../protocol/src/plugins/contributions/composerAttachments.ts',
    );
    const emittedModules = new Set<string>();

    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          {
            find: '@happier-dev/protocol/plugins/contributions/composer-attachments',
            replacement: protocolComposerAttachmentsEntry,
          },
          {
            find: '@happier-dev/protocol/plugins/manifest',
            replacement: protocolManifestEntry,
          },
        ],
      },
      plugins: [{
        name: 'define-plugin-browser-graph',
        generateBundle() {
          for (const id of this.getModuleIds()) emittedModules.add(id);
        },
      }],
      build: {
        minify: false,
        target: 'es2022',
        write: false,
        rollupOptions: {
          input: sdkEntry,
          preserveEntrySignatures: 'strict',
          output: {
            format: 'es',
            inlineDynamicImports: true,
          },
        },
      },
    });

    const forbiddenModules = [...emittedModules].filter((id) => (
      id.includes('node:')
      || id.includes('__vite-browser-external')
      || id.includes('/crypto/accountScopedCipher.')
      || id.includes('/machines/identity/installationIdentity.')
      || id.includes('/tweetnacl/')
    ));
    expect(forbiddenModules).toEqual([]);
  }, 60_000);
});
