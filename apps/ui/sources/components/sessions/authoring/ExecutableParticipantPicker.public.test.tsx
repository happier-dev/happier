import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { ExecutableParticipantPickerExample } from '../../../../../../packages/plugin-ui/fixtures/external-authoring/src/executableParticipantPickerSurface';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'android', select: <T,>(options: { android?: T; native?: T; default?: T }) => options.android ?? options.native ?? options.default } });
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');

function hosted(children: React.ReactNode) {
  return <PluginUiHostPresentationScope
    environment={projectHappierUiEnvironment(createPluginSurfaceContextFixture())}
    presentationHost={createPluginUiPrivatePresentationHost(undefined)}
  >{children}</PluginUiHostPresentationScope>;
}

describe('external executable participant picker through the real app presentation host', () => {
  it('keeps selection author-controlled, retains offline choices, and commits only on Done', async () => {
    expect(typeof publicComponents.ExecutableParticipantPicker).toBe('function');
    const screen = await renderScreen(hosted(<ExecutableParticipantPickerExample multiple />));
    expect(screen.getTextContent()).toContain('Machine offline');
    expect(screen.findByTestId('author-participant-picker-done')?.props.disabled).toBe(true);
    await act(async () => screen.pressByTestId('author-participant-design'));
    expect(screen.getTextContent()).toContain('No choice committed');
    expect(screen.findByTestId('author-participant-design')?.props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => screen.pressByTestId('author-participant-reconnect'));
    expect(screen.getTextContent()).not.toContain('Machine offline');
    expect(screen.findByTestId('author-participant-design')?.props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => screen.pressByTestId('author-participant-picker-done'));
    expect(screen.getTextContent()).toContain('Committed design');
    await screen.unmount();
  });

  it('selects immediately in single mode and searches through the same list owner', async () => {
    expect(typeof publicComponents.ExecutableParticipantPicker).toBe('function');
    const screen = await renderScreen(hosted(<ExecutableParticipantPickerExample />));
    // React test renderer exposes a generic props bag at this external boundary.
    const presented = screen.findByType(publicComponents.ExecutableParticipantPicker).props as React.ComponentProps<typeof publicComponents.ExecutableParticipantPicker>;
    const model = presented.sections.flatMap(section => section.options).find(option => option.id === 'review');
    expect(model?.searchText).toBe('GPT review');
    await act(async () => screen.changeTextByTestId(`${presented.testID}-search`, 'GPT review'));
    expect(screen.findByTestId(model!.testID!)).not.toBeNull();
    expect(screen.findByTestId('author-participant-picker-done')).toBeNull();
    await act(async () => screen.changeTextByTestId('author-participant-picker-search', 'Design'));
    expect(screen.findByTestId('author-participant-review')).toBeNull();
    await act(async () => screen.pressByTestId('author-participant-design'));
    expect(screen.getTextContent()).toContain('Chosen design');
    await screen.unmount();
  });

  it('confirms a caller-configured choice even when no listed Session row is marked', async () => {
    const screen = await renderScreen(hosted(<ExecutableParticipantPickerExample multiple configuredChoice />));
    expect(screen.findByTestId('author-participant-picker-done')?.props.disabled).toBe(false);
    await act(async () => screen.pressByTestId('author-participant-picker-done'));
    expect(screen.getTextContent()).toContain('Committed configured choice');
    await screen.unmount();
  });
});
