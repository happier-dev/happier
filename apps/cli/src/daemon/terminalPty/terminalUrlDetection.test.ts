import { describe, expect, it } from 'vitest';

import { createTerminalUrlDetector } from './terminalUrlDetection';

describe('TerminalUrlDetector', () => {
  it('extracts URLs from ANSI-colored output', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 2048 });
    const events = detector.ingest('\u001b[31mhttps://example.com\u001b[0m\n');
    expect(events).toEqual([
      expect.objectContaining({ url: 'https://example.com/', kind: 'generic' }),
    ]);
  });

  it('trims trailing punctuation from URLs', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 2048 });
    const events = detector.ingest('Open: https://example.com).\n');
    expect(events).toEqual([
      expect.objectContaining({ url: 'https://example.com/', kind: 'generic' }),
    ]);
  });

  it('detects URLs split across chunks', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 2048 });
    expect(detector.ingest('https://exam')).toEqual([]);
    const events = detector.ingest('ple.com\n');
    expect(events).toEqual([
      expect.objectContaining({ url: 'https://example.com/', kind: 'generic' }),
    ]);
  });

  it('dedupes URLs across repeated output', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 2048 });
    expect(detector.ingest('https://example.com\n')).toHaveLength(1);
    expect(detector.ingest('again https://example.com\n')).toHaveLength(0);
  });
});
