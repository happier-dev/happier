import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  analyzeRuntimeImportCycles,
  compareCyclesToBaseline,
  formatCycleKey,
} from '../importCycleGuard.mjs';

function withFixtureProject<T>(files: Readonly<Record<string, string>>, run: (paths: {
  rootDir: string;
  sourceRoot: string;
  tsconfigPath: string;
}) => T): T {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-cli-import-cycles-'));
  const sourceRoot = resolve(rootDir, 'src');
  const tsconfigPath = resolve(rootDir, 'tsconfig.json');

  try {
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: '.',
            module: 'ESNext',
            moduleResolution: 'bundler',
            noEmit: true,
            paths: {
              '@/*': ['./src/*'],
            },
            resolveJsonModule: true,
            target: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );

    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = resolve(sourceRoot, relativePath);
      mkdirSync(resolve(absolutePath, '..'), { recursive: true });
      writeFileSync(absolutePath, contents, 'utf8');
    }

    return run({ rootDir, sourceRoot, tsconfigPath });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe('importCycleGuard analyzer', () => {
  it('ignores deferred cycles but catches eager reads through a deferred return edge', () => {
    withFixtureProject({
      'a.ts': "import { b } from './b.js'; export const a = () => b;",
      'b.ts': "import { a } from './a.js'; export const b = () => a;",
    }, ({ sourceRoot, tsconfigPath }) => {
      expect(analyzeRuntimeImportCycles({ sourceRoot, tsconfigPath, evaluationOnly: true }).cycles).toEqual([]);
    });
    withFixtureProject({
      'a.ts': "import { b } from './b.js'; export const a = { b };",
      'b.ts': "import { a } from './a.js'; export const b = () => a;",
    }, ({ sourceRoot, tsconfigPath }) => {
      const result = analyzeRuntimeImportCycles({ sourceRoot, tsconfigPath, evaluationOnly: true });
      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]).toMatchObject({ read: { from: 'a.ts', to: 'b.ts', binding: 'b' } });
    });
  });

  it('distinguishes instance initialization from static fields and immediate calls', () => {
    for (const [initializer, eager] of [
      ['class A { field = b; method() { return b; } }', false],
      ['class A { static field = b; }', true],
      ['const A = (() => b)();', true],
    ] as const) {
      withFixtureProject({
        'a.ts': `import { b } from './b.js'; ${initializer} export { A };`,
        'b.ts': "import { A } from './a.js'; export const b = () => A;",
      }, ({ sourceRoot, tsconfigPath }) => {
        expect(analyzeRuntimeImportCycles({ sourceRoot, tsconfigPath, evaluationOnly: true }).cycles.length > 0).toBe(eager);
      });
    }
  });

  it('rejects a seeded new Protocol cycle at the command boundary and accepts its baseline', () => {
    withFixtureProject({
      'a.ts': "import { b } from './b.js'; export const a = b;",
      'b.ts': "import { a } from './a.js'; export const b = a;",
    }, ({ rootDir, sourceRoot, tsconfigPath }) => {
      const args = [fileURLToPath(new URL('../importCycleGuard.mjs', import.meta.url)), '--protocol',
        '--source-root', sourceRoot, '--tsconfig', tsconfigPath, '--baseline', join(rootDir, 'baseline.json')];
      const rejected = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('new cycle');
      expect(rejected.stderr).toContain('a.ts');
      expect(spawnSync(process.execPath, [...args, '--write-baseline'], { encoding: 'utf8' }).status).toBe(0);
      const accepted = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(accepted.status, accepted.stderr).toBe(0);
    });
  });

  it('detects runtime strongly connected components through alias and relative imports deterministically', () => {
    withFixtureProject(
      {
        'feature/a.ts': "import { b } from '@/feature/b';\nexport const a = b;\n",
        'feature/b.ts': "export { c as b } from './nested/c';\n",
        'feature/nested/c.ts': "import { a } from '../a';\nexport const c = a;\n",
      },
      ({ sourceRoot, tsconfigPath }) => {
        const result = analyzeRuntimeImportCycles({ sourceRoot, tsconfigPath });

        expect(result.cycles.map((cycle) => cycle.files)).toEqual([
          ['feature/a.ts', 'feature/b.ts', 'feature/nested/c.ts'],
        ]);
        expect(result.cycles[0]?.edges).toEqual([
          ['feature/a.ts', 'feature/b.ts'],
          ['feature/b.ts', 'feature/nested/c.ts'],
          ['feature/nested/c.ts', 'feature/a.ts'],
        ]);
      },
    );
  });

  it('ignores type-only imports, type-only exports, dynamic imports, and test files', () => {
    withFixtureProject(
      {
        'lazy.ts': "import { runtime } from './runtime';\nexport const lazy = runtime;\n",
        'runtime.test.ts': "import { runtime } from './runtime';\nexport const testValue = runtime;\n",
        'runtime.ts': [
          "import { type Model } from './types';",
          "import { testValue } from './runtime.test';",
          "import { testkitValue } from './support.testkit';",
          "import { testUtilsValue } from './support.testUtils';",
          "export { type Model } from './types';",
          "void import('./lazy');",
          "export const runtime = String(testValue) + String(testkitValue) + String(testUtilsValue);",
        ].join('\n'),
        'support.testkit.ts': "import { runtime } from './runtime';\nexport const testkitValue = runtime;\n",
        'support.testUtils.ts': "import { runtime } from './runtime';\nexport const testUtilsValue = runtime;\n",
        'types.ts': "import { runtime } from './runtime';\nexport interface Model { value: typeof runtime }\n",
      },
      ({ sourceRoot, tsconfigPath }) => {
        const result = analyzeRuntimeImportCycles({ sourceRoot, tsconfigPath });

        expect(result.cycles).toEqual([]);
      },
    );
  });

  it('compares current cycles against the baseline by SCC membership', () => {
    const allowedCycle = {
      files: ['a.ts', 'b.ts'],
      edges: [
        ['a.ts', 'b.ts'],
        ['b.ts', 'a.ts'],
      ],
    };
    const newCycle = {
      files: ['c.ts', 'd.ts'],
      edges: [
        ['c.ts', 'd.ts'],
        ['d.ts', 'c.ts'],
      ],
    };

    const comparison = compareCyclesToBaseline({
      baselineCycles: [{ files: ['b.ts', 'a.ts'] }, { files: ['stale.ts', 'old.ts'] }],
      currentCycles: [allowedCycle, newCycle],
    });

    expect(comparison.allowedCycles.map(formatCycleKey)).toEqual(['a.ts\nb.ts']);
    expect(comparison.newCycles.map(formatCycleKey)).toEqual(['c.ts\nd.ts']);
    expect(comparison.staleBaselineCycles.map(formatCycleKey)).toEqual(['old.ts\nstale.ts']);
  });
});
