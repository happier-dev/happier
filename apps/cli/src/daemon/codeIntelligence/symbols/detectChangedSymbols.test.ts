import { describe, expect, it } from 'vitest';

import { parseZeroContextHunks } from '../git/observedGit';
import { detectChangedSymbols } from './detectChangedSymbols';

const OLD_TS = [
  'import { a } from "./a";',
  '',
  'export function total(items: number[]): number {',
  '  return items.reduce((sum, item) => sum + item, 0);',
  '}',
  '',
  'export class Cart {',
  '  add(item: number): void {',
  '    this.items.push(item);',
  '  }',
  '',
  '  clear(): void {',
  '    this.items = [];',
  '  }',
  '}',
  '',
  'export function legacy(): void {',
  '}',
  '',
].join('\n');

const NEW_TS = [
  'import { a } from "./a";',
  '',
  'export function total(items: number[]): number {',
  '  return items.reduce((sum, item) => sum + item * 2, 0);',
  '}',
  '',
  'export class Cart {',
  '  add(item: number): void {',
  '    this.items.push(item);',
  '  }',
  '',
  '  clear(): void {',
  '    this.items.length = 0;',
  '  }',
  '}',
  '',
  'export const discount = (value: number) => value * 0.9;',
  '',
].join('\n');

const DIFF_TS = [
  '@@ -4 +4 @@ export function total(items: number[]): number {',
  '@@ -13 +13 @@ export class Cart {',
  '@@ -17,2 +17 @@ export class Cart {',
].join('\n');

describe('detectChangedSymbols', () => {
  it('attributes changed lines to the innermost declaration and reports added and deleted declarations', () => {
    const changed = detectChangedSymbols({
      path: 'src/cart.ts',
      oldContent: OLD_TS,
      newContent: NEW_TS,
      hunks: parseZeroContextHunks(DIFF_TS),
    });

    expect(changed.map((symbol) => [symbol.name, symbol.kind, symbol.changeKind])).toEqual([
      ['total', 'function', 'modified'],
      ['clear', 'method', 'modified'],
      ['discount', 'function', 'added'],
      ['legacy', 'function', 'deleted'],
    ]);
    expect(changed.every((symbol) => symbol.accuracy === 'declaration_scan')).toBe(true);
  });

  it('treats every declaration of a newly added file as added', () => {
    const content = 'def handler(event):\n    return event\n\nclass Worker:\n    def run(self):\n        pass\n';
    const changed = detectChangedSymbols({
      path: 'app/worker.py',
      oldContent: null,
      newContent: content,
      hunks: parseZeroContextHunks('@@ -0,0 +1,6 @@'),
    });

    expect(changed.map((symbol) => [symbol.name, symbol.kind, symbol.changeKind])).toEqual([
      ['handler', 'function', 'added'],
      ['Worker', 'class', 'added'],
      ['run', 'method', 'added'],
    ]);
  });

  it('finds a modified Rust method inside an impl block and a Go function', () => {
    const rustOld = 'impl Engine {\n    pub fn start(&self) {\n        self.run();\n    }\n}\n';
    const rustNew = 'impl Engine {\n    pub fn start(&self) {\n        self.run_fast();\n    }\n}\n';
    expect(detectChangedSymbols({
      path: 'src/engine.rs',
      oldContent: rustOld,
      newContent: rustNew,
      hunks: parseZeroContextHunks('@@ -3 +3 @@'),
    }).map((symbol) => [symbol.name, symbol.changeKind])).toEqual([['start', 'modified']]);

    const goOld = 'package main\n\nfunc (s *Server) Serve() error {\n\treturn nil\n}\n';
    const goNew = 'package main\n\nfunc (s *Server) Serve() error {\n\treturn s.listen()\n}\n';
    expect(detectChangedSymbols({
      path: 'server.go',
      oldContent: goOld,
      newContent: goNew,
      hunks: parseZeroContextHunks('@@ -4 +4 @@'),
    }).map((symbol) => [symbol.name, symbol.kind, symbol.changeKind])).toEqual([['Serve', 'method', 'modified']]);
  });

  it('attributes changes to Java and C# methods rather than only their class', () => {
    const javaOld = 'public class Cart {\n    public int total(List<Integer> items) {\n        return items.size();\n    }\n}\n';
    const javaNew = 'public class Cart {\n    public int total(List<Integer> items) {\n        return items.size() * 2;\n    }\n}\n';
    expect(detectChangedSymbols({
      path: 'src/Cart.java',
      oldContent: javaOld,
      newContent: javaNew,
      hunks: parseZeroContextHunks('@@ -3 +3 @@'),
    }).map((symbol) => [symbol.name, symbol.kind])).toEqual([['total', 'method']]);

    const csOld = 'public class Cart\n{\n    public async Task<int> TotalAsync()\n    {\n        return 1;\n    }\n}\n';
    const csNew = 'public class Cart\n{\n    public async Task<int> TotalAsync()\n    {\n        return 2;\n    }\n}\n';
    expect(detectChangedSymbols({
      path: 'Cart.cs',
      oldContent: csOld,
      newContent: csNew,
      hunks: parseZeroContextHunks('@@ -5 +5 @@'),
    }).map((symbol) => [symbol.name, symbol.kind])).toEqual([['TotalAsync', 'method']]);
  });

  it('keeps a body that follows a multi-line signature inside its declaration', () => {
    const tsOld = 'export function total(\n  items: number[],\n): number {\n  return 1;\n}\n';
    const tsNew = 'export function total(\n  items: number[],\n): number {\n  return 2;\n}\n';
    expect(detectChangedSymbols({
      path: 'total.ts',
      oldContent: tsOld,
      newContent: tsNew,
      hunks: parseZeroContextHunks('@@ -4 +4 @@'),
    }).map((symbol) => [symbol.name, symbol.changeKind])).toEqual([['total', 'modified']]);

    const pyOld = 'def total(\n    items,\n):\n    return 1\n';
    const pyNew = 'def total(\n    items,\n):\n    return 2\n';
    expect(detectChangedSymbols({
      path: 'total.py',
      oldContent: pyOld,
      newContent: pyNew,
      hunks: parseZeroContextHunks('@@ -4 +4 @@'),
    }).map((symbol) => [symbol.name, symbol.changeKind])).toEqual([['total', 'modified']]);
  });

  it('reports nothing for languages it cannot scan instead of guessing', () => {
    expect(detectChangedSymbols({
      path: 'README.md',
      oldContent: '# a\n',
      newContent: '# b\n',
      hunks: parseZeroContextHunks('@@ -1 +1 @@'),
    })).toEqual([]);
  });
});
