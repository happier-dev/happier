import { describe, expect, it } from 'vitest';
import { renderMachineFirewallOpenPortsV1 } from './machineFirewallV1.js';

describe('renderMachineFirewallOpenPortsV1', () => {
  it('writes one owned table: established and loopback first, a permit per opened port, then the one deny per chain', () => {
    const { rules } = renderMachineFirewallOpenPortsV1({ tcp: ['22'] });
    expect(rules).toBe([
      'table inet happier', 'delete table inet happier', 'table inet happier {',
      '  chain input {', '    type filter hook input priority filter - 10; policy accept;',
      '    ct state established,related accept', '    iifname "lo" accept',
      '    meta nfproto ipv4 tcp dport 22 accept', '    meta nfproto ipv6 tcp dport 22 accept',
      '    ct state new drop', '  }',
      '  chain forward {', '    type filter hook forward priority filter - 10; policy accept;',
      '    ct state established,related accept',
      '    meta l4proto tcp meta nfproto ipv4 ct original proto-dst 22 accept',
      '    meta l4proto tcp meta nfproto ipv6 ct original proto-dst 22 accept',
      '    ct state new ct direction original ct status dnat drop', '  }', '}', '',
    ].join('\n'));
  });

  it('refuses anything but port numbers and address ranges', () => {
    expect(() => renderMachineFirewallOpenPortsV1({ tcp: [] })).toThrow();
    expect(() => renderMachineFirewallOpenPortsV1({ tcp: ['0'] })).toThrow();
    expect(() => renderMachineFirewallOpenPortsV1({ tcp: ['22'], from: ['10.0.0.1'] })).toThrow();
    expect(() => renderMachineFirewallOpenPortsV1({ tcp: ['22'], rules: 'flush ruleset' })).toThrow();
  });
});
