import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

describe('metro.config.js (kokoro)', () => {
  it('overrides kokoro-js for web bundling', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../../metro.config.js');

    expect(config?.resolver?.resolveRequest).toEqual(expect.any(Function));

    const res = config.resolver.resolveRequest(
      {
        resolveRequest: () => ({ type: 'empty' }),
      },
      'kokoro-js',
      'web',
    );

    expect(res?.type).toBe('sourceFile');
    expect(String(res?.filePath)).toBe(resolve(process.cwd(), 'sources/platform/stubs/kokoroJsStub.ts'));

    const resDeep = config.resolver.resolveRequest(
      {
        resolveRequest: () => ({ type: 'empty' }),
      },
      'kokoro-js/dist/kokoro.web.js',
      'web',
    );
    expect(resDeep?.type).toBe('sourceFile');
    expect(String(resDeep?.filePath)).toBe(resolve(process.cwd(), 'sources/platform/stubs/kokoroJsStub.ts'));
  });

  it('shims Node builtins used by kokoro/transformers for native bundling', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../../metro.config.js');

    const resPath = config.resolver.resolveRequest(
      { resolveRequest: () => ({ type: 'empty' }) },
      'node:path',
      'ios',
    );
    expect(resPath?.type).toBe('sourceFile');
    expect(String(resPath?.filePath)).toBe(resolve(process.cwd(), 'sources/platform/nodeShims/nodePathShim.ts'));

    const resFs = config.resolver.resolveRequest(
      { resolveRequest: () => ({ type: 'empty' }) },
      'node:fs',
      'android',
    );
    expect(resFs?.type).toBe('sourceFile');
    expect(String(resFs?.filePath)).toBe(resolve(process.cwd(), 'sources/platform/nodeShims/nodeFsShim.ts'));

    const resFsPromises = config.resolver.resolveRequest(
      { resolveRequest: () => ({ type: 'empty' }) },
      'node:fs/promises',
      'ios',
    );
    expect(resFsPromises?.type).toBe('sourceFile');
    expect(String(resFsPromises?.filePath)).toBe(
      resolve(process.cwd(), 'sources/platform/nodeShims/nodeFsPromisesShim.ts'),
    );
  });

  it('normalizes the monorepo web entry request back to the UI workspace entry file', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../../metro.config.js');

    const res = config.resolver.resolveRequest(
      {
        originModulePath: resolve(process.cwd(), '..'),
        resolveRequest: () => ({ type: 'empty' }),
      },
      './apps/ui/index.ts',
      'web',
    );

    expect(res?.type).toBe('sourceFile');
    expect(String(res?.filePath)).toBe(resolve(process.cwd(), 'index.ts'));
  });

  it('does not inject the monorepo root into watchFolders when the workspace entry file already lives under projectRoot', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../../metro.config.js');
    const repoRoot = resolve(process.cwd(), '../..');

    expect(config.projectRoot).toBe(resolve(process.cwd()));
    expect(config.watchFolders).not.toContain(repoRoot);
  });
});
