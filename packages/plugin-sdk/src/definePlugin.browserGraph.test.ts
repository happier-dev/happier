import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

// The `definePlugin` authoring entry is bundled into browser and React Native hosts,
// so its reachable graph is a realm constraint, not a preference: the budget below is
// what keeps a Node-only or heavy validation graph (ajv/tweetnacl/semver) from silently
// riding along with the manifest authoring surface.
//
// The ceiling is the measured graph, not an aspiration. Severing the AJV compiler, the
// manifest ingest barrel and the Protocol catalog/provider graph from this entry took it
// from 435 modules / 1,450,703 bytes to 94 modules / 237,581 bytes on this same basis.
// What remains is `definePlugin.ts` itself (~50KB of authored surface) plus the single
// Zod copy that Protocol's schema DTO (`PluginJsonSchemaV2Schema`), its contribution-id
// schemas and `plugins/ui/targetedContributions` are built from; going lower means
// re-founding those three on the AJV-free composable-schema DSL, which is a Protocol
// schema-library decision this entry cannot make on its own.
//
// 256KiB is the measured 237,581 plus room for authored growth, and it is deliberately
// less than 237,581 + 72,818 — the cheapest thing that was severed (`semver`, reached
// through the manifest ingest barrel). So no severed owner can come back without
// tripping this, and the answer when it trips is to sever it again, not to widen the
// budget.
const BROWSER_GRAPH_MAX_BYTES = 256 * 1024;

/**
 * What this entry reaches is a source fact. Resolving `@happier-dev/protocol`
 * subpaths through the bundled workspace copy under `node_modules` would measure
 * whichever dist happened to be built last — and would keep measuring the old graph
 * after a source change — so every subpath Protocol's `exports` map publishes is
 * aliased to the file that produces it. Longest specifier first, because Vite matches
 * a string alias by prefix.
 */
function readProtocolSourceAliases(): readonly Readonly<{ find: string; replacement: string }>[] {
  const protocolDir = resolve(import.meta.dirname, '../../protocol');
  const manifest = JSON.parse(readFileSync(resolve(protocolDir, 'package.json'), 'utf8')) as Readonly<{
    exports: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
  }>;
  return Object.entries(manifest.exports)
    .flatMap(([subpath, target]) => {
      const distPath = typeof target === 'string' ? target : target.default;
      if (typeof distPath !== 'string') return [];
      return [{
        find: `@happier-dev/protocol${subpath.slice(1)}`,
        replacement: resolve(
          protocolDir,
          distPath.replace(/^\.\/dist\//u, './src/').replace(/\.js$/u, '.ts'),
        ),
      }];
    })
    .sort((left, right) => right.find.length - left.find.length);
}

const protocolSourceAliases = readProtocolSourceAliases();

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

  it('keeps manifest authoring validation out of Collection and full Action runtime modules', async () => {
    const sdkEntry = resolve(import.meta.dirname, './definePlugin.ts');
    const emittedModules = new Set<string>();
    const emittedChunkNames: string[] = [];
    let emittedBytes = 0;

    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: protocolSourceAliases },
      plugins: [{
        name: 'define-plugin-browser-graph',
        generateBundle(_outputOptions, bundle) {
          for (const id of this.getModuleIds()) emittedModules.add(id);
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            emittedChunkNames.push(output.fileName);
            emittedBytes += Buffer.byteLength(output.code);
          }
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
      // Named so a regression reports the owner that came back rather than only a byte
      // count. The AJV JSON Schema compiler belongs to `plugins/actions/jsonSchemaValidation`
      // and the composable-schema DSL to `plugins/actions/protocolComposableSchema`;
      // authoring a schema needs the second, never the first. `semver` and the manifest
      // ingest barrel arrive together the moment anything on this path imports
      // `@happier-dev/protocol/plugins/manifest` for an id schema.
      || id.includes('/ajv/')
      || id.includes('/ajv-formats/')
      || id.includes('/semver/')
      || id.includes('/protocol/src/plugins/manifest/')
      // Targeted contribution points share only Action's small surface/danger
      // vocabulary. Pulling the full Action declaration grammar drags its
      // daemon-only validation graph into browser and React Native hosts.
      || id.includes('/protocol/src/plugins/actions/v2.')
    ));
    expect(forbiddenModules).toEqual([]);
    // `inlineDynamicImports` fuses the browser realm into one chunk, so this counts the
    // emitted output chunks: it proves `emittedBytes` measures the whole graph instead of
    // one arbitrary slice of it. Counting module ids here (the reachable graph is
    // hundreds of modules) made this assertion unsatisfiable and short-circuited the
    // budget below, which had therefore never executed.
    expect(emittedChunkNames).toHaveLength(1);
    expect(emittedBytes).toBeLessThanOrEqual(BROWSER_GRAPH_MAX_BYTES);
  }, 60_000);
});
