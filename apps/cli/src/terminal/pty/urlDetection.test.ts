import { describe, expect, it } from 'vitest';

import { createTerminalUrlDetector } from './urlDetection';

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

  it('keeps scanning cost bounded for ordinary terminal output before a split URL', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 32_768 });
    const lines = (`${'x'.repeat(63)}\r\n`).repeat(4_033);
    const started = process.cpuUsage();
    for (let stream = 0; stream < 16; stream++) {
      for (let offset = 0; offset < lines.length; offset += 8192) {
        const detected = detector.ingest(lines.slice(offset, offset + 8192));
        if (detected.length > 0) throw new Error('Unexpected URL in plain terminal output');
      }
    }
    const cpu = process.cpuUsage(started);
    // Allow substantial headroom and exclude time spent waiting for CPU on shared test hosts.
    expect(cpu.user + cpu.system).toBeLessThan(120_000);

    expect(detector.ingest('Open https://exam')).toEqual([]);
    expect(detector.ingest('ple.com\r\n')).toEqual([{ url: 'https://example.com/', kind: 'generic' }]);
  });

  it('flushes a URL that ends at the stream boundary', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 2048 });
    expect(detector.ingest('Open https://example.com/final')).toEqual([]);

    expect(detector.flush()).toEqual([
      expect.objectContaining({ url: 'https://example.com/final', kind: 'generic' }),
    ]);
  });

  it('dedupes URLs across repeated output', () => {
    const detector = createTerminalUrlDetector({ bufferLimit: 2048 });
    expect(detector.ingest('https://example.com\n')).toHaveLength(1);
    expect(detector.ingest('again https://example.com\n')).toHaveLength(0);
  });

  it('bounds URL dedupe retention', () => {
    const params = { bufferLimit: 2048, seenLimit: 1 };
    const detector = createTerminalUrlDetector(params);

    expect(detector.ingest('https://one.example\n')).toHaveLength(1);
    expect(detector.ingest('https://two.example\n')).toHaveLength(1);
    expect(detector.ingest('again https://one.example\n')).toHaveLength(1);
  });
});
