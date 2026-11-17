import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { storage } from '@/sync/domains/state/storageStore';
import { useDeploymentDomainIngressFields } from './DeploymentDomainIngressFields';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(standardCleanup);

it.each([false, true])('offers first Connect with no saved account (DNS records only: %s)', async dnsRecordsOnly => {
  const serverId = await homes.addHome({ name: 'Fresh domain', serverUrl: 'https://fresh-domain.test',
    accountId: 'fresh-domain-owner', currentAccount: true });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: AccountProfileSchema.parse({ id: 'fresh-domain-owner' }) });
  function Form() {
    return useDeploymentDomainIngressFields({ hostname: 'app.example.test', busy: false,
      enabled: true, dnsRecordsOnly }).fields;
  }
  const screen = await renderAccountScreen(<Form />);
  try {
    const { EmptyState } = await import('@/components/ui/empty/EmptyState');
    const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
    expect(screen.findByTestId('project-deployments.environment.domains.add.ingress.zones.read')).not.toBeNull();
    expect(screen.findAllByType(EmptyState).some(node => typeof node.props.primaryAction?.onPress === 'function')).toBe(true);
    expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(0);
  } finally {
    await screen.unmount();
    account.dispose();
    await homes.reset();
  }
});
