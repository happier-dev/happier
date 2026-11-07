import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { PluginPublishPackageSection } from './PluginPublishScreen';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
afterEach(standardCleanup);

it('keeps the template review visible beside the ordinary package checks before publication', async () => {
    const controller = { preparation: null, pending: null, available: true, prepare: async () => undefined } satisfies
        React.ComponentProps<typeof PluginPublishPackageSection>['controller'];
    const botTemplate = { draftArtifactId: '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
        release: { v: 1 as const, version: '1.0.0', releasedAtMs: 1, changelog: '', content: {
            v: 1 as const, identity: { name: 'Garden', description: '' }, instructions: { markdown: 'Review plants' },
            skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] },
        } } };
    const screen = await renderScreen(<PluginPublishPackageSection controller={controller} botTemplate={botTemplate} />);
    expect(screen.findByTestId('plugin-publish.template-check')).toBeTruthy();
    await screen.unmount();
    const ordinary = await renderScreen(<PluginPublishPackageSection controller={controller} />);
    expect(ordinary.findByTestId('plugin-publish.template-check')).toBeNull();
});
