import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const publicationSubpaths = {
  './acpPresets': './dist/acpPresets.js',
  './providers/claude-model-options': './dist/providers/claudeModelOptions.js',
  './runtime/facets/transcriptDispatch': './dist/runtime/facets/transcriptDispatch.js',
  './runtime/session/recoverableTurnFailurePolicy': './dist/runtime/session/recoverableTurnFailurePolicy.js',
  './runtime/session/runtimeConfigUpdateOutcome': './dist/runtime/session/runtimeConfigUpdateOutcome.js',
  './runtime/session/scopedServices': './dist/runtime/session/scopedServices.js',
  './runtime/surfaces': './dist/runtime/surfaces/index.js',
  './runtime/terminal/control': './dist/runtime/terminal/control.js',
  './runtime/terminal/inputReadiness': './dist/runtime/terminal/inputReadiness.js',
  './runtime/terminal/promptWriteTimeout': './dist/runtime/terminal/promptWriteTimeout.js',
  './session/controls/metadataKeys': './dist/session/controls/metadataKeys.js',
  './session/controls/vendorResumePolicy': './dist/session/controls/vendorResumePolicy.js',
  './session/state/bindings/metadataKeys': './dist/session/state/bindings/metadataKeys.js',
  './session/state/metadataReaders': './dist/session/state/metadataReaders.js',
  './session/state/types': './dist/session/state/_types.js',
} as const;

describe('Agents publication subpaths', () => {
  it('maps each narrow publication leaf directly to its canonical source owner', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
      exports?: Record<string, Readonly<{ types?: string; default?: string }>>;
    };

    for (const [subpath, emittedOwner] of Object.entries(publicationSubpaths)) {
      expect(packageJson.exports?.[subpath]).toEqual({
        types: emittedOwner.replace(/\.js$/u, '.d.ts'),
        default: emittedOwner,
      });
      const sourceOwner = emittedOwner
        .replace(/^\.\/dist\//u, './src/')
        .replace(/\.js$/u, '.ts');
      expect(existsSync(resolve(packageDir, sourceOwner)), sourceOwner).toBe(true);
    }
  });

  it('keeps the terminal prompt timeout on its explicit Node-backed leaf', () => {
    const source = readFileSync(
      resolve(packageDir, 'src/runtime/terminal/promptWriteTimeout.ts'),
      'utf8',
    );
    expect(source).toContain("from 'node:buffer'");
  });
});
