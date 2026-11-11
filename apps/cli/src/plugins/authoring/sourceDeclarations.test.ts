import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveNativeTypeScriptBin } from './toolEntrypoints';
import { emitSourceAuthorDeclarations } from './sourceDeclarations';

const execute = promisify(execFile);

describe('source author declaration materialization', () => {
  it('emits portable inferred JSX declarations from captured ambient packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-author-declaration-'));
    const captured = join(root, 'dist/.happier-source');
    try {
      await mkdir(join(captured, 'src'), { recursive: true });
      await mkdir(join(captured, 'node_modules/@types/react'), { recursive: true });
      const manifest = JSON.stringify({ name: '@fixture/presentation', version: '1.0.0' });
      await writeFile(join(root, 'package.json'), manifest);
      await writeFile(join(captured, 'package.json'), manifest);
      await writeFile(join(captured, 'node_modules/@types/react/package.json'), JSON.stringify({ name: '@types/react', version: '1.0.0', types: 'index.d.ts' }));
      await writeFile(join(captured, 'node_modules/@types/react/index.d.ts'), 'export {};');
      await writeFile(join(captured, 'node_modules/@types/react/jsx-runtime.d.ts'), 'export namespace JSX { export interface Element { readonly rendered: true } export interface IntrinsicElements { panel: {} } }');
      await writeFile(join(captured, 'src/index.tsx'), 'export function Panel() { return <panel />; }');
      await writeFile(join(captured, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        target: 'es2022', module: 'nodenext', jsx: 'react-jsx', declaration: true,
        emitDeclarationOnly: true, noCheck: true, rootDir: '../../src', outDir: '..',
        typeRoots: ['./node_modules/@types'],
      }, files: ['../../src/index.tsx'] }));
      await emitSourceAuthorDeclarations([root], async (project, cwd) => {
        try {
          await execute(process.execPath, [resolveNativeTypeScriptBin(process.cwd()), '-p', project], { cwd });
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          throw new Error(`${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`);
        }
      });
      const declaration = await readFile(join(root, 'dist/index.d.ts'), 'utf8');
      expect(declaration).toContain('react/jsx-runtime');
      expect(declaration).not.toContain('.happier-source');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
