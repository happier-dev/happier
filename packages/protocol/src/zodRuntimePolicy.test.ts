import { describe, expect, it } from 'vitest';
import { z as classic } from 'zod';
import { z } from 'zod/mini';
import { lazyZodSchema } from './lazyZodSchema.js';

/**
 * Zod's default memoizer (installed globally by any classic `zod` container)
 * walks every nested definition on a schema's first parse, which resolves each
 * lazy definition even when the input never reaches it. Protocol input is JSON,
 * so cyclic-input support is off, exactly as under `zod/mini`.
 */
describe('zod runtime policy', () => {
  it('resolves Mini once for a source schema graph instead of once per schema module', async () => {
    const { build } = await import('esbuild');
    const bundle = await build({
      entryPoints: [new URL('./account/encryptionMode.ts', import.meta.url).pathname,
        new URL('./daemon/executionRuns.ts', import.meta.url).pathname],
      outdir: 'unused', bundle: true, platform: 'node', format: 'esm',
      packages: 'external', write: false, metafile: true, logLevel: 'silent',
    });
    const miniResolutions = Object.values(bundle.metafile!.inputs)
      .filter(input => input.imports.some(dependency => dependency.path === 'zod/mini'));
    expect(miniResolutions).toHaveLength(1);
  });

  it.each(['node', 'browser'] as const)('keeps unreached definitions cold in a tree-shaken %s consumer bundle', async (platform) => {
    const { build } = await import('esbuild');
    const { runInNewContext } = await import('node:vm');
    const bundle = await build({
      stdin: {
        resolveDir: import.meta.dirname,
        contents: `
          import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
          import { z as classic } from 'zod';
          import { z } from 'zod/mini';
          classic.object({ id: classic.string() }).strict();
          let constructed = 0;
          const grandchild = lazyZodSchema(() => { constructed++; return z.strictObject({ id: z.string() }); });
          const child = lazyZodSchema(() => z.strictObject({ grandchild }));
          const parent = lazyZodSchema(() => z.strictObject({ child }));
          export const invalidRejected = !parent.safeParse(undefined).success;
          export const unreachedDefinitions = constructed;
          export const validAccepted = parent.safeParse({ child: { grandchild: { id: 'kept' } } }).success;
          export const reachedDefinitions = constructed;
          export const extraRejected = !parent.safeParse({ child: { grandchild: { id: 'kept', extra: true } } }).success;
        `,
      },
      bundle: true, platform, format: 'cjs', conditions: ['happier-source'],
      treeShaking: true, write: false, metafile: true, logLevel: 'silent',
    });
    // Execute the bundled Zod instance, isolated from Vitest's source-level policy.
    const module = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports });
    expect(module.exports).toMatchObject({
      invalidRejected: true, unreachedDefinitions: 0,
      validAccepted: true, reachedDefinitions: 1, extraRejected: true,
    });
    const bundledInputs = Object.values(bundle.metafile!.outputs).flatMap(output => Object.entries(output.inputs));
    expect(bundledInputs.some(([path, input]) => path.endsWith('/zodRuntimePolicy.ts') && input.bytesInOutput > 0)).toBe(true);
    expect(bundle.warnings.filter(warning => warning.id === 'ignored-bare-import')).toEqual([]);
  });

  it('does not construct unreached lazy definitions on the first parse, even after a classic schema exists', () => {
    classic.object({ id: classic.string() }).strict();
    let constructed = 0;
    const grandchild = lazyZodSchema(() => { constructed++; return z.strictObject({ id: z.string() }); });
    const child = lazyZodSchema(() => z.strictObject({ grandchild }));
    const parent = lazyZodSchema(() => z.strictObject({ child }));

    expect(parent.safeParse(undefined).success).toBe(false);
    expect(constructed).toBe(0);
  });

  it('keeps strict accept/reject behaviour for classic and mini schemas', () => {
    const child = lazyZodSchema(() => z.strictObject({ id: z.string().check(z.minLength(1)) }));
    const mini = lazyZodSchema(() => z.strictObject({ child }));
    const strictClassic = classic.object({ child: classic.object({ id: classic.string().min(1) }).strict() }).strict();
    for (const schema of [mini, strictClassic]) {
      expect(schema.safeParse({ child: { id: 'x' } }).success).toBe(true);
      expect(schema.safeParse({ child: { id: '' } }).success).toBe(false);
      expect(schema.safeParse({ child: { id: 'x', extra: 1 } }).success).toBe(false);
      expect(schema.safeParse({ child: { id: 'x' }, extra: 1 }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });
});
