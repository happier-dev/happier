import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { useDeploymentDomainIngressFields, type DomainIngressInspection } from './DeploymentDomainIngressFields';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
afterEach(standardCleanup);

it('selects a connected DNS account and consumes the zone producer Action without preparing record values or reading tunnels', async () => {
  const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'dns-account' };
  const action = { pluginId: 'happier.deploy.cloudflare', localId: 'records-from-zone-producer' };
  // This public inspect port terminates the front-door Action transport. Provider parsing and form state stay real.
  const inspect = vi.fn<DomainIngressInspection>(async () => ({ ok: true, value: { kind: 'ready',
    zones: [{ zoneId: 'dns-zone', name: 'example.test' }], options: [], dnsRecordAction: action } }));
  let result: unknown;
  function Form() {
    const options = { hostname: 'app.example.test', busy: false, inspect, enabled: true, dnsRecordsOnly: true };
    const fields = useDeploymentDomainIngressFields(options);
    result = fields;
    return fields.fields;
  }
  const screen = await renderAccountScreen(<Form />);
  try {
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    await act(async () => screen.findAllByType(ConnectedAccountPurposeTargetChooser)[0]!.props.onChange({ kind: 'account', account: credentialRef }, null));
    await screen.pressByTestIdAsync('project-deployments.environment.domains.add.ingress.zones.read');
    expect(result).toMatchObject({ dns: { action, credentialRef, zoneId: 'dns-zone', ttl: 1 } });
    expect(inspect).toHaveBeenCalledExactlyOnceWith('happier.deploy.cloudflare/actions/workers-domain-zones-read',
      { credentialRef, hostname: 'app.example.test' }, { signal: expect.any(AbortSignal) });
    expect(screen.findByTestId('project-deployments.environment.domains.add.ingress.read')).toBeNull();
    expect(screen.findByTestId('project-deployments.environment.domains.add.ingress.imageRef')).toBeNull();
    await act(async () => screen.findByTestId('project-deployments.environment.domains.add.ingress.ttl')!.props.onChangeText('300'));
    expect(result).toMatchObject({ dns: { action, credentialRef, zoneId: 'dns-zone', ttl: 300 } });
  } finally { await screen.unmount(); }
});
