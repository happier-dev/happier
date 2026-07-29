import { describe, expect, it } from 'vitest';

import {
  assertManifestPathsSafe,
  assertModelPackFilePathPortable,
  assertPackIdFilesystemSafe,
  filePathParts,
} from './pathSafety.js';

describe('filePathParts', () => {
  it('splits a relative path into trimmed segments', () => {
    expect(filePathParts('a/b/c.bin')).toEqual(['a', 'b', 'c.bin']);
    expect(filePathParts(' a / b ')).toEqual(['a', 'b']);
  });

  it('rejects empty, absolute, backslash, traversal, and NUL paths', () => {
    for (const bad of ['', '   ', '/abs', '\\abs', 'a\\b', 'a/../b', './x', 'a\0b']) {
      expect(() => filePathParts(bad)).toThrow('model_pack_invalid_path');
    }
  });
});

describe('assertPackIdFilesystemSafe', () => {
  it('returns the trimmed id for safe ids', () => {
    expect(assertPackIdFilesystemSafe(' kokoro-tts-en-v1 ')).toBe('kokoro-tts-en-v1');
    expect(assertPackIdFilesystemSafe('A.b_c-1')).toBe('A.b_c-1');
  });

  it('rejects empty, dot, traversal, over-long, and unsafe ids', () => {
    expect(() => assertPackIdFilesystemSafe('')).toThrow();
    expect(() => assertPackIdFilesystemSafe('.')).toThrow();
    expect(() => assertPackIdFilesystemSafe('..')).toThrow();
    expect(() => assertPackIdFilesystemSafe('-leading-dash')).toThrow();
    expect(() => assertPackIdFilesystemSafe('has/slash')).toThrow();
    expect(() => assertPackIdFilesystemSafe('a'.repeat(257))).toThrow();
  });
});

describe('assertManifestPathsSafe', () => {
  it('passes when every file path is safe', () => {
    expect(() =>
      assertManifestPathsSafe({ files: [{ path: 'a/b.bin' }, { path: 'c.txt' }] }),
    ).not.toThrow();
  });

  it('throws when any file path is unsafe', () => {
    expect(() =>
      assertManifestPathsSafe({ files: [{ path: 'ok.bin' }, { path: '../escape' }] }),
    ).toThrow('model_pack_invalid_path');
  });

  it('rejects root paths owned by the installer host', () => {
    for (const path of [
      'pack.json',
      'Pack.JSON',
      '.resume-plan.json',
      '.RESUME-PLAN.JSON',
      '.reſume-plan.json',
    ]) {
      expect(() => assertManifestPathsSafe({ files: [{ path }] }))
        .toThrow(/model_pack_(?:reserved|invalid)_path/);
    }
  });

  it.each([
    'models/ſ.txt',
    'models/Σ.txt',
    'models/ς.txt',
    'models/café.txt',
    'models/cafe\u0301.txt',
  ])('rejects non-ASCII path contributors with the stable portable-path error: %s', (path) => {
    expect(() => assertModelPackFilePathPortable(path)).toThrow('model_pack_invalid_path');
    expect(() => assertManifestPathsSafe({ files: [{ path }] })).toThrow('model_pack_invalid_path');
  });

  it.each([
    ['models/S.txt', 'models/ſ.txt'],
    ['models/Σ.txt', 'models/ς.txt'],
    ['models/café.txt', 'models/cafe\u0301.txt'],
  ])('rejects filesystem-equivalent Unicode aliases: %s / %s', (first, second) => {
    expect(() => assertManifestPathsSafe({ files: [{ path: first }, { path: second }] }))
      .toThrow('model_pack_invalid_path');
  });

  it('rejects portable file-directory conflicts across case aliases', () => {
    expect(() => assertManifestPathsSafe({
      files: [{ path: 'models' }, { path: 'MODELS/encoder.onnx' }],
    })).toThrow('model_pack_path_file_directory_conflict');
  });
});
