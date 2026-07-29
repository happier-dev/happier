import { describe, expect, it } from 'vitest';

import { parseProviderIpAddress } from './index.js';

describe('provider IP locality', () => {
  it.each([
    ['127.0.0.2', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['93.184.216.34', 'public'],
    ['::1', 'loopback'],
    ['fd12:0:0:0:0:0:0:8', 'private'],
    ['fec0::1', 'private'],
    ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['2606:4700:4700::1111', 'public'],
  ] as const)('classifies %s as %s', (address, locality) => {
    expect(parseProviderIpAddress(address)?.locality).toBe(locality);
  });

  it.each([
    '0.0.0.0',
    '169.254.169.254',
    '100.100.100.200',
    '224.0.0.1',
    '::',
    'ff02::1',
    'fd00:ec2::254',
    'fd20:ce::254',
    '::ffff:169.254.169.254',
    '::ffff:100.100.100.200',
    '::127.0.0.1',
  ])('classifies unsafe or metadata address %s as unsafe', (address) => {
    expect(parseProviderIpAddress(address)?.locality).toBe('unsafe');
  });

  it('canonicalizes equivalent IPv6 spellings', () => {
    expect(parseProviderIpAddress('fd12:0:0:0:0:0:0:8')?.normalized).toBe('fd12::8');
    expect(parseProviderIpAddress('[FD12::0008]')?.normalized).toBe('fd12::8');
  });

  it.each(['127.1', '0177.0.0.1', '1.2.3.999', 'fe80::1%en0', 'not-an-ip'])(
    'rejects non-canonical or invalid address %s',
    (address) => {
      expect(parseProviderIpAddress(address)).toBeNull();
    },
  );

  // Derived from the IANA IPv4/IPv6 Special-Purpose Address Registries fetched
  // 2026-07-10. Each row exercises first/last/outside or a more-specific exception.
  it.each([
    // IPv4 non-global, exception, and boundary policy.
    ['0.0.0.0', 'unsafe'], ['0.255.255.255', 'unsafe'], ['1.0.0.0', 'public'],
    ['10.0.0.0', 'private'], ['10.255.255.255', 'private'], ['11.0.0.0', 'public'],
    ['100.64.0.0', 'private'], ['100.127.255.255', 'private'], ['100.128.0.0', 'public'],
    ['100.100.100.200', 'unsafe'],
    ['127.0.0.0', 'loopback'], ['127.255.255.255', 'loopback'], ['128.0.0.0', 'public'],
    ['169.253.255.255', 'public'], ['169.254.0.0', 'private'], ['169.254.255.255', 'private'],
    ['169.254.169.254', 'unsafe'], ['169.254.170.2', 'unsafe'], ['169.254.170.23', 'unsafe'],
    ['172.15.255.255', 'public'], ['172.16.0.0', 'private'], ['172.31.255.255', 'private'], ['172.32.0.0', 'public'],
    ['192.0.0.0', 'private'], ['192.0.0.7', 'private'], ['192.0.0.8', 'unsafe'],
    ['192.0.0.9', 'public'], ['192.0.0.10', 'public'], ['192.0.0.11', 'unsafe'],
    ['192.0.0.169', 'unsafe'], ['192.0.0.170', 'unsafe'], ['192.0.0.171', 'unsafe'], ['192.0.0.172', 'unsafe'],
    ['192.0.0.255', 'unsafe'],
    ['192.0.2.0', 'unsafe'], ['192.0.2.255', 'unsafe'], ['192.0.3.0', 'public'],
    ['192.31.196.0', 'public'], ['192.31.196.255', 'public'],
    ['192.52.193.0', 'public'], ['192.52.193.255', 'public'],
    ['192.88.99.0', 'unsafe'], ['192.88.99.1', 'unsafe'], ['192.88.99.2', 'private'],
    ['192.88.99.3', 'unsafe'], ['192.88.99.255', 'unsafe'],
    ['192.167.255.255', 'public'], ['192.168.0.0', 'private'], ['192.168.255.255', 'private'], ['192.169.0.0', 'public'],
    ['192.175.48.0', 'public'], ['192.175.48.255', 'public'],
    ['198.17.255.255', 'public'], ['198.18.0.0', 'private'], ['198.19.255.255', 'private'], ['198.20.0.0', 'public'],
    ['198.51.100.0', 'unsafe'], ['198.51.100.255', 'unsafe'], ['198.51.101.0', 'public'],
    ['203.0.113.0', 'unsafe'], ['203.0.113.255', 'unsafe'], ['203.0.114.0', 'public'],
    ['223.255.255.255', 'public'], ['224.0.0.0', 'unsafe'], ['239.255.255.255', 'unsafe'],
    ['240.0.0.0', 'unsafe'], ['255.255.255.255', 'unsafe'],

    // IPv6 special-purpose rows and longest-prefix exceptions.
    ['::', 'unsafe'], ['::1', 'loopback'],
    ['64:ff9b:1::', 'unsafe'], ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', 'unsafe'], ['64:ff9b:2::', 'unsafe'],
    ['100::', 'unsafe'], ['100::ffff:ffff:ffff:ffff', 'unsafe'], ['100:0:0:2::', 'unsafe'],
    ['100:0:0:1::', 'unsafe'], ['100:0:0:1:ffff:ffff:ffff:ffff', 'unsafe'],
    ['2001:5::', 'unsafe'], ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'], ['2001:200::', 'public'],
    ['2001::', 'private'], ['2001:0:ffff:ffff:ffff:ffff:ffff:ffff', 'private'], ['2001:1::', 'unsafe'],
    ['2001:1::1', 'public'], ['2001:1::2', 'public'], ['2001:1::3', 'public'], ['2001:1::4', 'unsafe'],
    ['2001:2::', 'private'], ['2001:2:0:ffff:ffff:ffff:ffff:ffff', 'private'], ['2001:2:1::', 'unsafe'],
    ['2001:3::', 'public'], ['2001:3:ffff:ffff:ffff:ffff:ffff:ffff', 'public'], ['2001:4::', 'unsafe'],
    ['2001:4:112::', 'public'], ['2001:4:112:ffff:ffff:ffff:ffff:ffff', 'public'], ['2001:4:113::', 'unsafe'],
    ['2001:10::', 'unsafe'], ['2001:1f:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'],
    ['2001:20::', 'public'], ['2001:2f:ffff:ffff:ffff:ffff:ffff:ffff', 'public'], ['2001:40::', 'unsafe'],
    ['2001:30::', 'public'], ['2001:3f:ffff:ffff:ffff:ffff:ffff:ffff', 'public'],
    ['2001:db8::', 'unsafe'], ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'], ['2001:db9::', 'public'],
    ['2620:4f:8000::', 'public'], ['2620:4f:8000:ffff:ffff:ffff:ffff:ffff', 'public'],
    ['3fff::', 'unsafe'], ['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'], ['4000::', 'unsafe'],
    ['5f00::', 'private'], ['5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'], ['5f01::', 'unsafe'],
    ['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'], ['fc00::', 'private'], ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'], ['fe80::', 'private'], ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['fec0::', 'private'], ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['ff00::', 'unsafe'], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unsafe'],
    ['fd00:ec2::254', 'unsafe'],
    ['fd20:ce::254', 'unsafe'],
  ] as const)('applies the registry-derived locality policy to %s as %s', (address, locality) => {
    expect(parseProviderIpAddress(address)?.locality).toBe(locality);
  });

  it.each([
    // IPv4-mapped, RFC 6052 NAT64, and 6to4 embed a source-real IPv4 address.
    ['::ffff:0.0.0.0', 'unsafe'],
    ['::ffff:192.0.0.9', 'public'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:192.0.2.1', 'unsafe'],
    ['::ffff:255.255.255.255', 'unsafe'],
    ['64:ff9b::0.0.0.0', 'unsafe'],
    ['64:ff9b::192.0.0.9', 'public'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::169.254.169.254', 'unsafe'],
    ['64:ff9b::255.255.255.255', 'unsafe'],
    // RFC 8215 local-use /48 keeps machine-local scope for otherwise-safe
    // destinations, but every RFC 6052 layout that can be nested beneath the
    // reservation must still deny an embedded metadata destination.
    ['64:ff9b:1:a9fe:a9:fe00::', 'unsafe'],
    ['64:ff9b:1:42a9:fe:a9fe::', 'unsafe'],
    ['64:ff9b:1:4242:a9:fea9:fe00:0', 'unsafe'],
    ['64:ff9b:1:4242:42:4242:a9fe:a9fe', 'unsafe'],
    ['64:ff9b:1:c0a8:1:101:5db8:d822', 'private'],
    ['64:ff9b:1:5db8:d8:2201:5db8:d822', 'private'],
    ['64:ff9b:1:a00:100:100::', 'unsafe'],
    ['2002:0000:0000::', 'unsafe'],
    ['2002:c000:0009::', 'public'],
    ['2002:0a00:0001::', 'private'],
    ['2002:7f00:0001::', 'loopback'],
    ['2002:c000:0201::', 'unsafe'],
    ['2002:ffff:ffff::', 'unsafe'],
  ] as const)('classifies transition address %s from embedded IPv4 as %s', (address, locality) => {
    expect(parseProviderIpAddress(address)?.locality).toBe(locality);
  });
});
