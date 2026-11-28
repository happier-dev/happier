import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { DeploymentVolumeRemovalFact } = await import('./DeploymentVolumeRemovalFact');
afterEach(standardCleanup);

it.each(['review', 'receipt'] as const)('names the Railway volume in the %s', async phase => {
    const screen = await renderScreen(<DeploymentVolumeRemovalFact phase={phase} serverId={null}
        volumeRemoval={{ kind: 'removed', volume: { name: 'postgres-volume', provider: 'Railway' } }}
        testID="volume-removal" />);
    expect(screen.getTextContent()).toContain('postgres-volume');
});

it('shows the generic removal consequence when review has no named volume', async () => {
    const screen = await renderScreen(<DeploymentVolumeRemovalFact phase="review" serverId={null}
        volumeRemoval={{ kind: 'removed' }} testID="volume-removal" />);
    expect(screen.getTextContent()).toContain(t('projects.deployments.review.railwayVolumeWillRemove'));
});
