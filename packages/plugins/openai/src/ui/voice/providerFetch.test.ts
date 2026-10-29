import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'web' }));
const nativeFetch = vi.hoisted(() => ({ loaded: false, fetch: vi.fn() }));
vi.mock('react-native', () => ({ Platform: platform }));
// Expo and the browser fetch are the native/HTTP system boundaries.
vi.mock('expo/fetch', () => {
  nativeFetch.loaded = true;
  return { fetch: nativeFetch.fetch };
});

afterEach(() => {
  platform.OS = 'web';
  vi.unstubAllGlobals();
  vi.resetModules();
  nativeFetch.loaded = false;
  nativeFetch.fetch.mockReset();
});

describe('portable OpenAI provider fetch', () => {
  it.each(['web', 'ios', 'android'])('preserves lazy native fetch interop in a compiled %s payload', async (os) => {
    const { build } = createRequire(new URL('../../../../../../apps/cli/package.json', import.meta.url))('esbuild') as typeof import('esbuild');
    // Only the RN platform and Expo native bridge are system boundaries. Compile
    // the actual consumer and its lazy import; expose the bridge as CommonJS.
    const result = await build({ entryPoints: [fileURLToPath(new URL('./providerFetch.ts', import.meta.url))],
      platform: 'browser', format: 'cjs', bundle: true, write: false, logLevel: 'silent',
      plugins: [{ name: 'native-platform-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(react-native|expo\/fetch)$/ }, args => ({ path: args.path, namespace: 'native-boundary' }));
        builder.onLoad({ filter: /.*/, namespace: 'native-boundary' }, args => ({ contents: args.path === 'react-native'
          ? 'module.exports = platformBoundary;'
          : 'fetchBoundary.loaded = true; module.exports = { fetch: fetchBoundary.fetch };' }));
      } }],
    });
    const response = new Response('compiled answer');
    const browserFetch = vi.fn(async () => response);
    const bridge = { loaded: false, fetch: vi.fn(async () => response) };
    vi.stubGlobal('fetch', browserFetch);
    const module: { exports: { openAiProviderFetch?: typeof globalThis.fetch } } = { exports: {} };
    new Function('platformBoundary', 'fetchBoundary', 'module', 'exports', result.outputFiles[0]!.text)(
      { Platform: { OS: os } }, bridge, module, module.exports);
    expect(bridge.loaded).toBe(false);
    const fetch = module.exports.openAiProviderFetch;
    if (!fetch) throw new Error('Missing compiled fetch export');
    const input = 'https://api.openai.com/v1/realtime/calls';
    const init = { method: 'POST', redirect: 'error' as const, signal: new AbortController().signal };
    expect(await fetch(input, init)).toBe(response);
    expect(bridge.loaded).toBe(os !== 'web');
    expect(os === 'web' ? browserFetch : bridge.fetch).toHaveBeenCalledWith(input, init);
    expect(os === 'web' ? bridge.fetch : browserFetch).not.toHaveBeenCalled();
  });

  it('keeps native fetch unevaluated during web signaling', async () => {
    const response = new Response('browser answer');
    const webFetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', webFetch);
    const { openAiProviderFetch } = await import('./providerFetch.js');
    const init = { method: 'POST', redirect: 'error' as const, signal: new AbortController().signal };
    expect(await openAiProviderFetch('https://api.openai.com/v1/realtime/calls', init)).toBe(response);
    expect(webFetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', init);
    expect(nativeFetch.loaded).toBe(false);
  });

  it.each(['ios', 'android'])('uses Expo fetch on %s while preserving cancellation and redirect policy', async (os) => {
    platform.OS = os;
    const response = new Response('native answer');
    nativeFetch.fetch.mockResolvedValue(response);
    const webFetch = vi.fn();
    vi.stubGlobal('fetch', webFetch);
    const { openAiProviderFetch } = await import('./providerFetch.js');
    expect(nativeFetch.loaded).toBe(false);
    const init = { method: 'POST', redirect: 'error' as const, signal: new AbortController().signal };
    expect(await openAiProviderFetch('https://api.openai.com/v1/realtime/calls', init)).toBe(response);
    expect(nativeFetch.fetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', init);
    expect(webFetch).not.toHaveBeenCalled();
  });
});
