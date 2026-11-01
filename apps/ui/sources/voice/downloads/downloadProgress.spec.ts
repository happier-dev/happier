import { describe, expect, it } from 'vitest';

import { formatDownloadProgressDetail, parseDownloadProgress } from './downloadProgress';

describe('parseDownloadProgress', () => {
  it('parses number fractions as percent', () => {
    expect(parseDownloadProgress(0.25)).toEqual({ percent: 25, label: null, bytes: null, files: null, verifiedBytes: null });
  });

  it('parses percent numbers directly', () => {
    expect(parseDownloadProgress(42)).toEqual({ percent: 42, label: null, bytes: null, files: null, verifiedBytes: null });
  });

  it('parses loaded/total into percent and byte counts', () => {
    expect(parseDownloadProgress({ loaded: 50, total: 200 })).toEqual({
      percent: 25,
      label: null,
      bytes: { loaded: 50, total: 200 },
      files: null,
      verifiedBytes: null,
    });
  });

  it('parses model pack file counts', () => {
    expect(parseDownloadProgress({ loaded: 50, total: 200, filesDone: 120, filesTotal: 362 })).toMatchObject({
      percent: 25,
      files: { done: 120, total: 362 },
    });
  });

  it('parses verified bytes within the transfer size', () => {
    expect(parseDownloadProgress({ loaded: 200, total: 200, verified: 150 }).verifiedBytes).toBe(150);
    expect(parseDownloadProgress({ loaded: 200, total: 200, verified: 900 }).verifiedBytes).toBe(200);
    expect(parseDownloadProgress({ loaded: 200, total: 200 }).verifiedBytes).toBeNull();
  });

  it('ignores file counts that cannot describe a transfer', () => {
    expect(parseDownloadProgress({ loaded: 1, total: 2, filesDone: 0, filesTotal: 0 }).files).toBeNull();
    expect(parseDownloadProgress({ loaded: 1, total: 2, filesDone: Number.NaN, filesTotal: 4 }).files).toBeNull();
  });

  it('parses progress + name into percent + filename label', () => {
    expect(parseDownloadProgress({ progress: 0.5, name: 'onnx/model_quantized.onnx' })).toEqual({
      percent: 50,
      label: 'model_quantized.onnx',
      bytes: null,
      files: null,
      verifiedBytes: null,
    });
  });

  it('keeps label when percent is unknown', () => {
    expect(parseDownloadProgress({ status: 'downloading', name: 'voices/af_heart.bin' })).toEqual({
      percent: null,
      label: 'af_heart.bin',
      bytes: null,
      files: null,
      verifiedBytes: null,
    });
  });
});

describe('formatDownloadProgressDetail', () => {
  it('returns a human friendly fallback when there is no progress data', () => {
    expect(formatDownloadProgressDetail(null)).toBe('Downloading…');
  });

  it('formats percent + label', () => {
    expect(formatDownloadProgressDetail({ progress: 0.9, name: 'foo/bar.bin' })).toBe('90% • bar.bin');
  });

  it('formats label only', () => {
    expect(formatDownloadProgressDetail({ name: 'foo/bar.bin' })).toBe('bar.bin');
  });

  it('supports a prefix', () => {
    expect(formatDownloadProgressDetail({ progress: 0.9, name: 'foo/bar.bin' }, { prefix: 'Downloading' })).toBe(
      'Downloading • 90% • bar.bin',
    );
  });
});
