import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Fault only the filesystem boundary; both publication owners remain real.
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

import {
  assertGeneratedOutputMatches,
  publishCoherentProjectionOutputs,
  removeRetiredGeneratedOutput,
  writeFileAtomic,
} from './outputs.ts';

const roots: string[] = [];

afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bundled-plugin-outputs-'));
  roots.push(root);
  return root;
}

describe('bundled Plugin output ownership', () => {
  it('retains recovery bytes when publication and rollback both fail', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const root = fixtureRoot();
    const first = join(root, 'one.ts');
    const second = join(root, 'two.ts');
    writeFileSync(first, 'last-green-one\n');
    writeFileSync(second, 'last-green-two\n');
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      const from = String(source);
      if (from.includes('.rollback')) throw Object.assign(new Error('rollback fault'), { code: 'EIO' });
      if (String(destination) === second) throw Object.assign(new Error('publication fault'), { code: 'EIO' });
      fs.renameSync(source, destination);
    });
    expect(() => publishCoherentProjectionOutputs(root, [
      { outPath: first, out: 'candidate-one\n' },
      { outPath: second, out: 'candidate-two\n' },
    ], { assertOwned: () => {} })).toThrow(AggregateError);
    const recoveryRoots = readdirSync(root).filter(name => name.endsWith('.rollback'));
    expect(recoveryRoots).toHaveLength(1);
    const recoveryRoot = join(root, recoveryRoots[0]!);
    expect(readdirSync(recoveryRoot).map(name => readFileSync(join(recoveryRoot, name), 'utf8')).sort())
      .toEqual(['last-green-one\n', 'last-green-two\n']);
    expect(readdirSync(root).filter(name => name.startsWith('.bundled-plugin-projection-stage-')))
      .toEqual(recoveryRoots);
  });
  it('writes changed atomic leaves and leaves identical bytes untouched', () => {
    const root = fixtureRoot();
    const path = join(root, 'projection.ts');

    expect(writeFileAtomic(path, 'first\n')).toBe(true);
    expect(writeFileAtomic(path, 'first\n')).toBe(false);
    expect(writeFileAtomic(path, 'second\n')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('second\n');
  });

  it('publishes a coherent projection family and rejects a path outside its root', () => {
    const root = fixtureRoot();
    const first = join(root, 'one.ts');
    const second = join(root, 'nested', 'two.ts');

    publishCoherentProjectionOutputs(root, [
      { outPath: first, out: 'one\n' },
      { outPath: second, out: 'two\n' },
    ], { assertOwned: () => {} });

    expect(readFileSync(first, 'utf8')).toBe('one\n');
    expect(readFileSync(second, 'utf8')).toBe('two\n');
    expect(() => publishCoherentProjectionOutputs(root, [
      { outPath: join(root, '..', 'escaped.ts'), out: 'no\n' },
    ], { assertOwned: () => {} })).toThrow(/escapes its root/u);
  });

  it('preserves the live projection when the publication lease is lost after staging', () => {
    const root = fixtureRoot();
    const path = join(root, 'projection.ts');
    writeFileSync(path, 'last-green\n', 'utf8');

    expect(() => publishCoherentProjectionOutputs(
      root,
      [{ outPath: path, out: 'candidate\n' }],
      {
        assertOwned: () => {
          expect(readdirSync(root).some(
            (name) => name.startsWith('.bundled-plugin-projection-stage-'),
          )).toBe(true);
          throw Object.assign(new Error('lost workspace lock ownership'), {
            code: 'EWORKSPACEBUNDLELOCKOWNERSHIPLOST',
          });
        },
      },
    )).toThrow(expect.objectContaining({ code: 'EWORKSPACEBUNDLELOCKOWNERSHIPLOST' }));
    expect(readFileSync(path, 'utf8')).toBe('last-green\n');
  });

  it('shares check/write behavior for current and retired outputs', () => {
    const root = fixtureRoot();
    const path = join(root, 'retired.ts');
    writeFileSync(path, 'old\n', 'utf8');

    expect(() => assertGeneratedOutputMatches(path, 'new\n')).toThrow(/differs/u);
    expect(readFileSync(path, 'utf8')).toBe('old\n');
    expect(() => assertGeneratedOutputMatches(path, 'old\n')).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('old\n');
    expect(() => removeRetiredGeneratedOutput(path, 'check')).toThrow(/retired/u);
    removeRetiredGeneratedOutput(path, 'write');
    expect(() => assertGeneratedOutputMatches(path, 'old\n')).toThrow(/missing/u);
  });
});
