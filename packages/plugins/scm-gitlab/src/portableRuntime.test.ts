import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';
import { GITLAB_TRIAGE_ACTION_IDS as SOURCE_ACTION_IDS } from './triage/contribution.js';

describe('Account source runtime portability', () => {
  it('places finite Account reads together and keeps local workspaces on the daemon', () => {
    const nativeIds = new Set<string>([SOURCE_ACTION_IDS.prepareReviewWorkspace, SOURCE_ACTION_IDS.verifyReviewWorkspace]);
    for (const { id } of PLUGIN_MANIFEST.contributes.actions.filter(({ id }) => !nativeIds.has(id))) {
      expect(PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === id)?.execution).toEqual({
        target: 'account', account: { artifactId: 'gitlab-account-runtime', exportName: 'activate' },
      });
    }
    for (const id of [SOURCE_ACTION_IDS.prepareReviewWorkspace, SOURCE_ACTION_IDS.verifyReviewWorkspace]) {
      expect(PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === id)?.execution).toEqual({ target: 'daemon' });
    }
  });

  it('loads the HTTP source owner in a browser without Node adapters', async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'refuse-node-adapters',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('node:') || builtinModules.includes(id)) {
            throw new Error(`Portable source imports Node adapter: ${id}`);
          }
          return null;
        },
      }],
      build: {
        write: false,
        minify: false,
        target: 'es2022',
        rollupOptions: {
          input: fileURLToPath(new URL('./accountRuntime.ts', import.meta.url)),
          external: (id) => id.startsWith('@happier-dev/'),
          preserveEntrySignatures: 'strict',
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    expect(result).toHaveProperty('output');
  });
});
