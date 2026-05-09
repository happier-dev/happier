import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toNodeImportSpecifier } from './tsxImportHook';

describe('tsxImportHook', () => {
  it('keeps non-Windows import specifiers as absolute paths', () => {
    const importPath = '/tmp/happier/tsx/dist/esm/index.mjs';
    expect(toNodeImportSpecifier(importPath, 'darwin')).toBe(importPath);
    expect(toNodeImportSpecifier(importPath, 'linux')).toBe(importPath);
  });

  it('converts Windows absolute import paths to file URLs', () => {
    const importPath = 'C:\\Users\\test_qa\\remote-dev-v026\\node_modules\\tsx\\dist\\esm\\index.mjs';
    expect(toNodeImportSpecifier(importPath, 'win32')).toBe(pathToFileURL(importPath).href);
  });
});
