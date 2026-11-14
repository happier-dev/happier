import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
import { HOST_PROVIDED_MODULES_FILE } from './hostProvidedModules.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

// Every host evaluates the generated table in its own realm. Bundle it the way Metro
// resolves packages for React Native and evaluate it where no Node global exists:
// only the web globals the React Native host provides.
test('every host-provided Protocol module evaluates in a realm without Node globals', async () => {
  const bundled = await build({
    absWorkingDir: packageRoot, entryPoints: [`./${HOST_PROVIDED_MODULES_FILE}`], bundle: true, write: false,
    format: 'iife', globalName: 'hostProtocol', platform: 'browser', target: 'es2020', logLevel: 'silent',
    mainFields: ['react-native', 'browser', 'module', 'main'], conditions: ['react-native', 'browser', 'module', 'import', 'default'],
  });
  const realm = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, atob, btoa });
  vm.runInContext(`${bundled.outputFiles[0].text}\nglobalThis.table = hostProtocol.PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULES;`, realm);
  const table = realm.table;
  expect(vm.runInContext('typeof process + typeof require + typeof Buffer', realm)).toBe('undefinedundefinedundefined');
  expect(Object.keys(table).length).toBeGreaterThan(0);
  expect(Object.entries(table).filter(([, namespace]) => !namespace || typeof namespace !== 'object').map(([specifier]) => specifier))
    .toEqual([]);
}, 120_000);
