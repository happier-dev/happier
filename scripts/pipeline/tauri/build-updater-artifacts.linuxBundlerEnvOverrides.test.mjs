import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLinuxTauriBundlerEnvOverrides } from './build-updater-artifacts.mjs';

test('resolveLinuxTauriBundlerEnvOverrides defaults to a safe config for AppImage bundling', () => {
  assert.deepEqual(resolveLinuxTauriBundlerEnvOverrides({}), {
    APPIMAGE_EXTRACT_AND_RUN: '1',
    LINUXDEPLOY_EXCLUDED_LIBRARIES: 'libwayland-client.so*;libwayland-cursor.so*;libwayland-egl.so*;libwayland-server.so*',
    NO_STRIP: '1',
    RUST_BACKTRACE: '1',
    RUST_LOG: 'tauri_bundler=debug',
  });
});

test('resolveLinuxTauriBundlerEnvOverrides preserves explicit env overrides', () => {
  assert.deepEqual(
    resolveLinuxTauriBundlerEnvOverrides({
      APPIMAGE_EXTRACT_AND_RUN: '0',
      LINUXDEPLOY_EXCLUDED_LIBRARIES: 'custom.so*',
      NO_STRIP: '0',
      RUST_BACKTRACE: '0',
      RUST_LOG: 'tauri_bundler=trace',
    }),
    {
      APPIMAGE_EXTRACT_AND_RUN: '0',
      LINUXDEPLOY_EXCLUDED_LIBRARIES: 'custom.so*',
      NO_STRIP: '0',
      RUST_BACKTRACE: '0',
      RUST_LOG: 'tauri_bundler=trace',
    },
  );
});
