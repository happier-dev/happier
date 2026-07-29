import { describe, expect, it } from 'vitest';

import { compareMachineHosts, normalizeMachineHost } from './normalizeMachineHost.js';

describe('normalizeMachineHost', () => {
  it('normalizes case and known LAN suffixes', () => {
    expect(normalizeMachineHost('LEEROY-MBP.local')).toBe('leeroy-mbp');
    expect(normalizeMachineHost('host.lan')).toBe('host');
    expect(normalizeMachineHost('host.localdomain')).toBe('host');
  });

  it('returns an empty string for blank inputs', () => {
    expect(normalizeMachineHost(null)).toBe('');
    expect(normalizeMachineHost(undefined)).toBe('');
    expect(normalizeMachineHost('  ')).toBe('');
  });

  it('keeps non-local domains intact', () => {
    expect(normalizeMachineHost('build.EXAMPLE.com')).toBe('build.example.com');
  });
});

describe('compareMachineHosts', () => {
  it('treats bare and local-suffixed hostnames as equal', () => {
    expect(compareMachineHosts('LEEROY-MBP.local', 'leeroy-mbp')).toBe(true);
    expect(compareMachineHosts('box.lan', 'BOX')).toBe(true);
    expect(compareMachineHosts('node.localdomain', 'node')).toBe(true);
  });

  it('returns false for different or missing hosts', () => {
    expect(compareMachineHosts('mbp', 'imac')).toBe(false);
    expect(compareMachineHosts('', 'mbp')).toBe(false);
    expect(compareMachineHosts('mbp', null)).toBe(false);
  });
});
