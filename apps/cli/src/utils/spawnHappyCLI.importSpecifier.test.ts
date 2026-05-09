import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toNodeImportSpecifier } from './spawnHappyCLI';

describe('spawnHappyCLI import specifier normalization', () => {
  it('keeps non-Windows absolute import paths unchanged', () => {
    const loaderPath = '/opt/happier/node_modules/tsx/dist/esm/index.mjs';
    expect(toNodeImportSpecifier(loaderPath, 'linux')).toBe(loaderPath);
    expect(toNodeImportSpecifier(loaderPath, 'darwin')).toBe(loaderPath);
  });

  it('converts Windows absolute import paths to file URLs for node --import', () => {
    const loaderPath = 'C:\\Users\\test_qa\\remote-dev-v026\\node_modules\\tsx\\dist\\esm\\index.mjs';
    expect(toNodeImportSpecifier(loaderPath, 'win32')).toBe(pathToFileURL(loaderPath).href);
  });
});
