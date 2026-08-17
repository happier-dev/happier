import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('composer-reference provider browser graph', () => {
  it('reaches only the bounded Protocol candidate-id leaf', async () => {
    const sdkEntry = resolve(import.meta.dirname, './composerReferenceProviders.ts');
    const protocolRoot = resolve(import.meta.dirname, '../../protocol/src/index.ts');
    const protocolCandidateIdLeaf = resolve(
      import.meta.dirname,
      '../../protocol/src/plugins/contributions/composerReferenceCandidateIdV1.ts',
    );
    const emittedModules = new Set<string>();
    const protocolPackage = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '../../protocol/package.json'),
      'utf8',
    )) as { exports?: Record<string, unknown> };

    expect(protocolPackage.exports).toHaveProperty(
      './plugins/contributions/composer-reference-candidate-id',
      {
        types: './dist/plugins/contributions/composerReferenceCandidateIdV1.d.ts',
        default: './dist/plugins/contributions/composerReferenceCandidateIdV1.js',
      },
    );

    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          {
            find: '@happier-dev/protocol/plugins/contributions/composer-reference-candidate-id',
            replacement: protocolCandidateIdLeaf,
          },
          { find: /^@happier-dev\/protocol$/, replacement: protocolRoot },
        ],
      },
      plugins: [{
        name: 'composer-reference-provider-browser-graph',
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
      || id.includes('/plugins/data/collectionsV1.')
      || id.includes('/crypto/accountScopedCipher.')
      || id.includes('/installationIdentity.')
      || id.includes('/tweetnacl/')
    ));
    expect(forbiddenModules).toEqual([]);
    expect([...emittedModules].filter((id) => (
      id.includes('/plugins/contributions/composerReferenceCandidateIdV1.')
    ))).toHaveLength(1);
  }, 60_000);
});
