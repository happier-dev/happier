/**
 * Tests for the QR code utility.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('renders the title banner and indented qr lines', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });

    vi.mocked(qrcode.generate).mockImplementation((_url, _opts, callback) => {
      callback?.('line-1\nline-2');
    });

    displayQRCode('handy://test');

    expect(vi.mocked(qrcode.generate)).toHaveBeenCalledWith(
      'handy://test',
      { small: true },
      expect.any(Function),
    );
    expect(logs).toContain('=========='.repeat(8));
    expect(logs).toContain('📱 To authenticate, scan this QR code with your mobile device:');
    expect(logs).toContain('          line-1');
    expect(logs).toContain('          line-2');
  });

  it('does not throw when qr payload is empty', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(qrcode.generate).mockImplementation((_url, _opts, callback) => {
      callback?.('');
    });

    expect(() => displayQRCode('handy://empty')).not.toThrow();
  });
});
