import { describe, expect, it } from 'vitest';

import { toNodeImportSpecifier } from './spawnHappyCLI';

describe('spawnHappyCLI import specifier normalization', () => {
  it('keeps non-Windows absolute import paths unchanged', () => {
    const loaderPath = '/opt/happier/node_modules/tsx/dist/esm/index.mjs';
    expect(toNodeImportSpecifier(loaderPath, 'linux')).toBe(loaderPath);
    expect(toNodeImportSpecifier(loaderPath, 'darwin')).toBe(loaderPath);
  });

  it('converts native absolute import paths to escaped file URLs for Windows node --import', () => {
    // Use the host's path syntax: only native Windows can establish drive-letter semantics.
    const loaderPath = process.platform === 'win32'
      ? 'C:\\Users\\test qa\\node_modules\\tsx\\dist\\esm\\index.mjs'
      : '/opt/happier/test qa/node_modules/tsx/dist/esm/index.mjs';
    const expectedUrl = process.platform === 'win32'
      ? 'file:///C:/Users/test%20qa/node_modules/tsx/dist/esm/index.mjs'
      : 'file:///opt/happier/test%20qa/node_modules/tsx/dist/esm/index.mjs';
    expect(toNodeImportSpecifier(loaderPath, 'win32')).toBe(expectedUrl);
  });
});
