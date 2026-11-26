import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { DeploymentPlatformInspectState } from './DeploymentPlatformInspectState';
import { readPlatformInspectOutcome } from './platformTargetLink';
import { HappyError } from '@/utils/errors/errors';
import { readDeploymentActionError } from './deploymentActionOutcome';

afterEach(standardCleanup);

it('renders the missing Source repository remedy from the plugin refusal without offering a provider Git grant', async () => {
  const outcome = readPlatformInspectOutcome({ ok: false, code: 'repository_required' });
  const onOpenRecovery = vi.fn();
  const screen = await renderScreen(<DeploymentPlatformInspectState outcome={outcome} onOpenRecovery={onOpenRecovery} />);
  const visible = screen.root.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
  await screen.pressByTestId('project-deployments.platform.refused.next');
  expect(onOpenRecovery).toHaveBeenCalledWith('source');
  expect(visible).not.toContain('repository_required');
  expect(screen.findByTestId('project-deployments.platform.needsGitAccess')).toBeNull();
  expect(screen.findByTestId('project-deployments.platform.ready')).toBeNull();
});

it('shows the missing Source file reported by the inspection Action', async () => {
  const outcome = readDeploymentActionError(new HappyError('Source file unavailable', false, {
    code: 'deployment_source_unavailable',
    details: { kind: 'deploymentSourceFileUnavailable', path: 'deploy/compose.yaml', reason: 'absent' },
  }));
  if (outcome.kind !== 'refused') throw new Error('Expected the inspection refusal');
  const onOpenRecovery = vi.fn();
  const screen = await renderScreen(<DeploymentPlatformInspectState outcome={outcome} onOpenRecovery={onOpenRecovery} />);
  await screen.pressByTestId('project-deployments.platform.refused.next');
  expect(onOpenRecovery).toHaveBeenCalledExactlyOnceWith('source');
  expect(screen.getTextContent()).toContain('deploy/compose.yaml');
});
