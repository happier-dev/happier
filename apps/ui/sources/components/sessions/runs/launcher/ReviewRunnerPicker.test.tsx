import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ReviewRunnerPicker } from '@happier-dev/plugin-ui/components';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';

// Native layout and portal placement are platform boundaries; the picker and selection owner remain real.
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const { renderReviewRunnerPicker } = await import('./ReviewRunnerPickerPresentation');
afterEach(standardCleanup);

it('selects an offered runner through public Plugin UI and the shared native menu', async () => {
    const chosen: string[] = [];
    function Launcher() {
        const [selected, setSelected] = React.useState('first');
        return <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(createSurfaceContextFixture())}
            presentationHost={{ renderReviewRunnerPicker }}>
            <ReviewRunnerPicker testID="public-runner" title="Agent" selectedId={selected}
                options={[{ id: 'first', title: 'First Agent' },
                    { id: 'second', title: 'Second Agent', testID: 'public-runner-second' }]}
                onSelect={value => { chosen.push(value); setSelected(value); }} />
        </PluginUiHostPresentationScope>;
    }
    const screen = await renderScreen(<Launcher />);
    await screen.pressByTestIdAsync('public-runner');
    await vi.waitFor(() => expect(screen.findAllHostsByTestId('public-runner-second').length).toBeGreaterThan(0));
    await screen.pressByTestIdAsync('public-runner-second');
    await vi.waitFor(() => expect(chosen).toEqual(['second']));
    expect(screen.getTextContent()).toContain('Second Agent');
    expect(screen.findAllHostsByTestId('public-runner-second')).toHaveLength(0);
});
