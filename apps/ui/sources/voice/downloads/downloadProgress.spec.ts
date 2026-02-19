import { describe, expect, it } from 'vitest';

import { formatDownloadProgressDetail, parseDownloadProgress } from './downloadProgress';

describe('parseDownloadProgress', () => {
  it('parses number fractions as percent', () => {
    expect(parseDownloadProgress(0.25)).toEqual({ percent: 25, label: null });
  });

  it('parses percent numbers directly', () => {
    expect(parseDownloadProgress(42)).toEqual({ percent: 42, label: null });
  });

  it('parses loaded/total into percent', () => {
    expect(parseDownloadProgress({ loaded: 50, total: 200 })).toEqual({ percent: 25, label: null });
  });

  it('parses progress + name into percent + filename label', () => {
    expect(parseDownloadProgress({ progress: 0.5, name: 'onnx/model_quantized.onnx' })).toEqual({
      percent: 50,
      label: 'model_quantized.onnx',
    });
  });

  it('keeps label when percent is unknown', () => {
    expect(parseDownloadProgress({ status: 'downloading', name: 'voices/af_heart.bin' })).toEqual({
      percent: null,
      label: 'af_heart.bin',
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
