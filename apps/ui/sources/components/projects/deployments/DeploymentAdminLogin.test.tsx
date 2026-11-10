// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { standardCleanup } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

const { DeploymentAdminLogin } = await import('./DeploymentAdminLogin');
const scope = { serverId: 'home', accountId: 'account-owner' };
const template = {
  templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
    ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } },
  definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
  services: ['app'], firstRunSetup: true as const,
  loginFields: { username: 'APP_USER', password: 'APP_PASSWORD' },
};

it('shows the declared username and exact image, with Domains as the first-admin next step', async () => {
  const base = createDeploymentEnvironmentDetailV1();
  const detail = createDeploymentEnvironmentDetailV1({ content: { ...base.content, template,
    bindings: [
      { purpose: 'variable', name: 'APP_USER', phase: 'build', source: { kind: 'value', value: 'builder' } },
      { purpose: 'variable', name: 'APP_USER', phase: 'runtime', source: { kind: 'value', value: 'owner' } },
    ],
  } });
  const domains = vi.fn();
  const image = createDeploymentReceiptDetailV1().content.images[0]!;
  const screen = await renderAccountScreen(<DeploymentAdminLogin template={detail.content.template ?? null}
    bindings={detail.content.bindings} images={[{ ...image, registryReference: 'uptime-kuma:2' }]}
    scope={scope} active servingUrl={null} onOpenDomains={domains} />);
  expect(screen.findHostByTestId('project-deployments.environment.services.login.username')).not.toBeNull();
  expect(screen.getTextContent()).toContain('owner');
  expect(screen.getTextContent()).not.toContain('builder');
  expect(screen.findHostByTestId('project-deployments.environment.services.image:app')).not.toBeNull();
  expect(screen.getTextContent()).toContain(`sha256:${'b'.repeat(64)}`);
  expect(screen.getTextContent()).toContain('uptime-kuma:2');
  await screen.pressByTestIdAsync('project-deployments.environment.services.firstRun.domains');
  expect(domains).toHaveBeenCalledOnce();
});

it('offers the admitted first-admin address instead of a Domains prerequisite', async () => {
  const open = vi.fn();
  const domains = vi.fn();
  const screen = await renderAccountScreen(<DeploymentAdminLogin template={template} bindings={[]} images={[]}
    scope={scope} active servingUrl="https://app.example.test/setup" onOpenDomains={domains} onOpenServing={open} />);
  await screen.pressByTestIdAsync('project-deployments.environment.services.firstRun.open');
  expect(open).toHaveBeenCalledWith('https://app.example.test/setup');
  expect(domains).not.toHaveBeenCalled();
});
