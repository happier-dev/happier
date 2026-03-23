/**
 * Tests for the QR code utility.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn(),
  },
}));

import qrcode from 'qrcode-terminal';

import { displayQRCode } from './qrcode.js';

describe('QR Code Utility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an optional title banner and indented qr lines', () => {
    const output = captureConsoleLogAndMuteStdout();

    try {
      vi.mocked(qrcode.generate).mockImplementation((_url, _opts, callback) => {
        callback?.('line-1\nline-2');
      });

      displayQRCode('handy://test', { title: 'Scan this QR code:' } as any);

      expect(vi.mocked(qrcode.generate)).toHaveBeenCalledWith(
        'handy://test',
        { small: true },
        expect.any(Function),
      );
      expect(output.logs).toContain('=========='.repeat(8));
      expect(output.logs).toContain('Scan this QR code:');
      expect(output.logs).not.toContain('📱 To authenticate, scan this QR code with your mobile device:');
      expect(output.logs).toContain('          line-1');
      expect(output.logs).toContain('          line-2');
    } finally {
      output.restore();
    }
  });

  it('does not throw when qr payload is empty', () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      vi.mocked(qrcode.generate).mockImplementation((_url, _opts, callback) => {
        callback?.('');
      });

      expect(() => displayQRCode('handy://empty')).not.toThrow();
    } finally {
      output.restore();
    }
  });
});
