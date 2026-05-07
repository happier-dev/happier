import { describe, expect, it } from 'vitest';

import { compareMachineHosts, normalizeMachineHost } from './normalizeMachineHost';

describe('normalizeMachineHost', () => {
  it('strips trailing .local and lowercases', () => {
    expect(normalizeMachineHost('leeroy-mbp.local')).toBe('leeroy-mbp');
    expect(normalizeMachineHost('LEEROY-MBP.LOCAL')).toBe('leeroy-mbp');
  });

  it('strips trailing .lan and .localdomain', () => {
    expect(normalizeMachineHost('host.lan')).toBe('host');
    expect(normalizeMachineHost('host.localdomain')).toBe('host');
  });

  it('returns the trimmed lowercase value when no LAN suffix is present', () => {
    expect(normalizeMachineHost('  mbp  ')).toBe('mbp');
    expect(normalizeMachineHost('mbp.example.corp')).toBe('mbp.example.corp');
  });

  it('returns an empty string for blank inputs', () => {
    expect(normalizeMachineHost(null)).toBe('');
    expect(normalizeMachineHost(undefined)).toBe('');
    expect(normalizeMachineHost('')).toBe('');
    expect(normalizeMachineHost('   ')).toBe('');
  });
});

describe('compareMachineHosts', () => {
  it('treats Bonjour-suffixed and bare host names as equal', () => {
    expect(compareMachineHosts('leeroy-mbp.local', 'leeroy-mbp')).toBe(true);
    expect(compareMachineHosts('LEEROY-MBP', 'leeroy-mbp.local')).toBe(true);
  });

  it('treats different hosts as not equal', () => {
    expect(compareMachineHosts('mbp', 'imac')).toBe(false);
    expect(compareMachineHosts('mbp.local', 'imac.local')).toBe(false);
  });

  it('returns false when either side is blank', () => {
    expect(compareMachineHosts('', 'mbp')).toBe(false);
    expect(compareMachineHosts('mbp', null)).toBe(false);
    expect(compareMachineHosts(null, undefined)).toBe(false);
  });
});
