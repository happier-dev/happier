import { resolve } from 'node:path';

/**
 * Compiled layout is `<package>/dist/main/paths.js`, so the package root is two levels up.
 * This is the only module that depends on the compiled depth; everything else derives from here.
 */
export const DESKTOP_PACKAGE_ROOT = resolve(__dirname, '..', '..');

export const REPO_APPS_ROOT = resolve(DESKTOP_PACKAGE_ROOT, '..');

/**
 * The web bundle produced by `yarn workspace @happier-dev/app tauri:prepare:build`. Both desktop
 * targets consume the same export; this one serves it on the `happier://localhost` scheme, the
 * counterpart of the Tauri target's `tauri://localhost`.
 */
export const UI_WEB_BUNDLE_DIR = resolve(REPO_APPS_ROOT, 'ui', 'dist');

export const PRELOAD_SCRIPT_PATH = resolve(DESKTOP_PACKAGE_ROOT, 'dist', 'preload', 'index.js');
