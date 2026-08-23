import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertGeneratedOutputMatches,
  publishCoherentProjectionOutputs,
  removeRetiredGeneratedOutput,
  writeFileAtomic,
} from './outputs.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bundled-plugin-outputs-'));
  roots.push(root);
  return root;
}

describe('bundled Plugin output ownership', () => {
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
    ]);

    expect(readFileSync(first, 'utf8')).toBe('one\n');
    expect(readFileSync(second, 'utf8')).toBe('two\n');
    expect(() => publishCoherentProjectionOutputs(root, [
      { outPath: join(root, '..', 'escaped.ts'), out: 'no\n' },
    ])).toThrow(/escapes its root/u);
  });

  it('shares check/write behavior for current and retired outputs', () => {
    const root = fixtureRoot();
    const path = join(root, 'retired.ts');
    writeFileSync(path, 'old\n', 'utf8');

    expect(() => assertGeneratedOutputMatches(path, 'new\n')).toThrow(/differs/u);
    expect(() => removeRetiredGeneratedOutput(path, 'check')).toThrow(/retired/u);
    removeRetiredGeneratedOutput(path, 'write');
    expect(() => assertGeneratedOutputMatches(path, 'old\n')).toThrow(/missing/u);
  });
});
