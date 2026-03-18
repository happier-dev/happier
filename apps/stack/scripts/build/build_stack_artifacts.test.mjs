import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as buildModule from './build_stack_artifacts.mjs';
import { readCliDistIntegrity } from '../utils/cli/cliDistIntegrity.mjs';

test('readCliDistIntegrity reports missing and present dist entrypoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-cli-dist-integrity-'));
  const distEntrypoint = join(root, 'dist', 'index.mjs');

  try {
    assert.deepEqual(readCliDistIntegrity(distEntrypoint), {
      ok: false,
      reason: 'missing_entrypoint',
    });

    mkdirSync(dirname(distEntrypoint), { recursive: true });
    writeFileSync(distEntrypoint, 'export const ok = true;\n', 'utf8');

    assert.deepEqual(readCliDistIntegrity(distEntrypoint), {
      ok: true,
      reason: 'exists',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertSelectedBuildPrerequisites does not require bun for web-only builds', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.doesNotThrow(() =>
    buildModule.assertSelectedBuildPrerequisites({
      selection: {
        components: {
          web: true,
          server: false,
          daemon: false,
        },
      },
      commandProbe: () => false,
    }),
  );
});

test('assertSelectedBuildPrerequisites fails fast when server artifacts need bun', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: true,
            daemon: false,
          },
        },
        commandProbe: () => false,
      }),
    /bun.*required.*server/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast for activate-runtime builds before web export starts', () => {
    assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
    assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: true,
            server: true,
            daemon: true,
          },
        },
        commandProbe: () => false,
      }),
    /bun.*server and daemon/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast when daemon artifacts need yarn or corepack', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: false,
            daemon: true,
          },
        },
        commandProbe: (cmd) => cmd === 'bun',
      }),
    /yarn or corepack/i,
  );
});
