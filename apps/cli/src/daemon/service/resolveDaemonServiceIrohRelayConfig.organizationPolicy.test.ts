import { describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { resolveDaemonServiceIrohRelayConfig } from './resolveDaemonServiceIrohRelayConfig';

describe('organization daemon relay config', () => {
  it('forced disabled relays override process lists', () => {
    const organizationPolicy = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","relays":{"policy":"disabled"}}');
    expect(resolveDaemonServiceIrohRelayConfig({ organizationPolicy, processEnv: { HAPPIER_IROH_RELAY_URLS: 'https://outside.example' } })).toEqual({ relayPolicy: 'disabled', relayUrls: [], explicitlyConfigured: true });
  });
  it('forced automatic relay list survives process disable and absent restores the process choice', () => {
    const organizationPolicy = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","relays":{"policy":"automatic","urls":["https://relay.example"]}}');
    expect(resolveDaemonServiceIrohRelayConfig({ organizationPolicy, processEnv: { HAPPIER_IROH_RELAY_POLICY: 'disabled' } })).toEqual({ relayPolicy: 'automatic', relayUrls: ['https://relay.example'], explicitlyConfigured: true });
    expect(resolveDaemonServiceIrohRelayConfig({ organizationPolicy: { status: 'absent' }, processEnv: { HAPPIER_IROH_RELAY_POLICY: 'disabled' } }).relayPolicy).toBe('disabled');
  });
});
