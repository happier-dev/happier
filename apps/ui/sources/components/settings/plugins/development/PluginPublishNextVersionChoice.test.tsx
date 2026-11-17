import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPluginPublishDraft } from './pluginPublishDraft';
import { PluginPublishNextVersionChoice } from './PluginPublishScreen';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
afterEach(standardCleanup);

type Controller = React.ComponentProps<typeof PluginPublishNextVersionChoice>['controller'];
const nextVersions = { patch: '1.0.1', minor: '1.1.0', major: '2.0.0' };

it('offers the next patch, minor or major only once a version is published, so a first publish shows no unselected choice', async () => {
    const draft = createPluginPublishDraft({ version: '1.0.0' });
    const first: Controller = { draft, pending: null, inspection: { nextVersions, history: { versions: [] } } };
    const screen = await renderScreen(<PluginPublishNextVersionChoice controller={first} />);
    expect(screen.findAllByProps({ role: 'radiogroup' })).toHaveLength(0);
    await screen.unmount();
    const released: Controller = { draft, pending: null, inspection: { nextVersions, history: { versions: [{ version: '1.0.0' }] } } };
    const next = await renderScreen(<PluginPublishNextVersionChoice controller={released} />);
    expect(next.findAllByProps({ role: 'radiogroup' }).length).toBeGreaterThan(0);
});
