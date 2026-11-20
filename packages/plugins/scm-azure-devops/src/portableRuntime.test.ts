import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { AZURE_DEVOPS_EVENT_ACTION_IDS } from './eventActionIds.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS as SOURCE_ACTION_IDS } from './triage/actions.js';

describe('Account source runtime portability', () => {
  it('keeps event Actions and local workspaces on the daemon and other Actions on the Account runtime', () => {
    const nativeIds = new Set<string>([
      ...Object.values(AZURE_DEVOPS_EVENT_ACTION_IDS),
      SOURCE_ACTION_IDS.prepareReviewWorkspace,
      SOURCE_ACTION_IDS.verifyReviewWorkspace,
    ]);
    for (const { id, execution } of PLUGIN_MANIFEST.contributes.actions.filter(({ id }) => !nativeIds.has(id))) {
      expect(execution, id).toEqual({
        target: 'account', account: { artifactId: 'azure-devops-account-runtime', exportName: 'activate' },
      });
    }
    for (const id of nativeIds) {
      expect(PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === id)?.execution, id).toEqual({ target: 'daemon' });
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
