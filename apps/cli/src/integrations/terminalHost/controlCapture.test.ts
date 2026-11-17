import { describe, expect, it } from 'vitest';

import {
  buildTerminalControlCapture,
  normalizeCapturedScreen,
  stripTerminalControlSequences,
} from './controlCapture';

const ESC = String.fromCharCode(0x1b);

describe('controlCapture', () => {
  describe('stripTerminalControlSequences', () => {
    it('removes CSI colour/style sequences while keeping the text', () => {
      const input = `${ESC}[31mred${ESC}[0m text`;
      expect(stripTerminalControlSequences(input)).toBe('red text');
    });

    it('removes OSC sequences terminated by BEL or ST', () => {
      const bel = `${ESC}]0;window title${String.fromCharCode(0x07)}body`;
      const st = `${ESC}]8;;https://example.com${ESC}\\link`;
      expect(stripTerminalControlSequences(bel)).toBe('body');
      expect(stripTerminalControlSequences(st)).toBe('link');
    });

    it('leaves plain text untouched', () => {
      expect(stripTerminalControlSequences('no escapes here')).toBe('no escapes here');
    });
  });

  describe('normalizeCapturedScreen', () => {
    it('strips ANSI and preserves multi-line structure', () => {
      const input = `${ESC}[1mline1${ESC}[0m\r\nline2\r\nline3`;
      expect(normalizeCapturedScreen(input)).toBe('line1\nline2\nline3');
    });

    it('normalizes CR and CRLF to LF and trims trailing spaces per line', () => {
      const input = 'line1   \r\nline2\t\rline3  ';
      expect(normalizeCapturedScreen(input)).toBe('line1\nline2\nline3');
    });

    it('drops trailing blank lines (capture-pane right padding) but keeps interior blanks', () => {
      const input = 'header\n\nbody\n\n\n';
      expect(normalizeCapturedScreen(input)).toBe('header\n\nbody');
    });
  });

  describe('buildTerminalControlCapture', () => {
    it('returns a normalized, host-tagged, timestamped capture and preserves the styled raw (ported S-8)', () => {
      const rawText = `${ESC}[32m> ${ESC}[0m  \n`;
      const capture = buildTerminalControlCapture({
        rawText,
        hostKind: 'tmux',
        capturedAtMs: 1234,
      });
      expect(capture).toEqual({ text: '>', styledText: `${ESC}[32m> ${ESC}[0m  `, capturedAtMs: 1234, hostKind: 'tmux' });
    });

    it('drops the trailing blank rows of the styled capture, as of the plain text (capture-pane pads to the pane height)', () => {
      // A bottom-anchored dialog parser reads the last rows: padding rows hid the safeguard dialog (XTERM-PARITY F3).
      const rows = [`${ESC}[1mDialog title${ESC}[0m`, '', `${ESC}[2m❯ 1. Continue${ESC}[0m`];
      const capture = buildTerminalControlCapture({
        rawText: [...rows, '   ', `${ESC}[0m`, `${ESC}[49m  `, ''].join('\n'),
        hostKind: 'tmux',
        capturedAtMs: 1,
      });
      expect(capture.styledText).toBe(rows.join('\n'));
      expect(capture.text).toBe('Dialog title\n\n❯ 1. Continue');
    });

    it('omits styledText for a plain capture so style-aware parsers fail closed (ported S-8)', () => {
      const capture = buildTerminalControlCapture({
        rawText: '> draft\n',
        hostKind: 'zellij',
        capturedAtMs: 99,
        cursor: { x: 2, y: 0 },
      });
      expect(capture).toEqual({ text: '> draft', cursor: { x: 2, y: 0 }, capturedAtMs: 99, hostKind: 'zellij' });
    });
  });
});
