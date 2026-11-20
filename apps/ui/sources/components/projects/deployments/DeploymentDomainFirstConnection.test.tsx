import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { storage } from '@/sync/domains/state/storageStore';
import { useDeploymentDomainIngressFields, type DomainIngressInspection } from './DeploymentDomainIngressFields';

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

it.each([false, true])('selects a sole eligible Cloudflare account and reads its zones (second eligible: %s)', async secondEligible => {
  const accountId = 'domain-owner';
  const serverId = await homes.addHome({ name: 'Domain Home', serverUrl: 'https://domain-selection.test',
    accountId, currentAccount: true });
  const features = createRootLayoutFeaturesResponse({
    capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
  });
  for (const path of ['/v1/features', '/v1/features/authenticated']) homes.answer(serverId, path, { body: features });
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  const cloudflare = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.deploy.cloudflare/cloudflare'];
  if (!cloudflare) throw new Error('Expected the bundled Cloudflare account declaration');
  const { service, descriptor } = cloudflare;
  const entry = projectConnectedAccountDescriptorV1({
    descriptor, pluginId: service.pluginId, serviceId: descriptor.id,
    provenance: 'first_party', sourceKind: 'bundled',
    availability: { state: 'available', reason: 'ready' }, diagnostics: [],
  });
  installConnectedAccountDescriptorProjection({
    scopeKey: serverId, status: 'ready', descriptors: [entry], conflicts: [], errorReason: null,
  }, account.accountLifetime);
  const profileAccount = (id: string, eligible: boolean) => ({
    ref: { service, accountId: id },
    status: eligible ? 'connected' : 'needs_reauth',
    authenticationModeId: descriptor.authentication.defaultModeId,
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    configurationReady: true,
    configurationRevision: null,
    displayName: id,
    scopes: [],
  });
  storage.setState({ profileScope: account.accountLifetime.scope,
    profile: AccountProfileSchema.parse({ id: accountId,
      connectedAccountsV4: [profileAccount('work', true), profileAccount('spare', secondEligible)] }) });
  const hostname = 'app.example.test';
  const inspect = vi.fn<DomainIngressInspection>(async () => ({ ok: true, value: { kind: 'ready', zones: [] } }));
  function Form() {
    const enteredHost = { hostname, committedHostname: hostname };
    return useDeploymentDomainIngressFields({ ...enteredHost, busy: false, enabled: true, inspect }).fields;
  }
  const screen = await renderAccountScreen(<Form />);
  try {
    if (secondEligible) {
      expect(inspect).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('/selections-read'), { credentialRef: { service, accountId: 'work' }, hostname },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ));
    }
  } finally {
    await screen.unmount();
    retireConnectedAccountDescriptorProjection(account.accountLifetime);
    account.dispose();
    await homes.reset();
  }
});
