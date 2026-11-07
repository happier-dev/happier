import type * as React from 'react';
import { act } from 'react-test-renderer';
import { expect } from 'vitest';
import { renderScreen, waitForTestEvent } from '@/dev/testkit';

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** Wait for the real reader to publish the connection, rather than guessing promise turns. */
export async function renderReadyProviderDetail(element: React.ReactElement): Promise<Screen> {
    const screen = await renderScreen(element);
    await waitForTestEvent(screen.subscribe, () => {
        expect(screen.findByTestId('provider-connection-detail')).not.toBeNull();
    });
    return screen;
}

export async function pressAndFlush(item: { props: { onPress?: () => unknown } } | undefined): Promise<void> {
    expect(item?.props.onPress).toBeTypeOf('function');
    // A UI press starts an operation; approval/pending tests observe its next
    // publication before deciding it, so they must not await the operation here.
    await act(async () => { item!.props.onPress!(); });
}

/** Advanced is a real rendered control; a missing disclosure must fail the test. */
export async function openAdvanced(screen: Screen): Promise<void> {
    await waitForTestEvent(screen.subscribe, () => {
        expect(screen.findByTestId('provider-connection-advanced')).not.toBeNull();
    });
    const row = screen.findAllByTestId('provider-connection-advanced')
        .find(node => typeof node.props.accessibilityExpanded === 'boolean')!;
    if (!row.props.accessibilityExpanded) await screen.pressByTestIdAsync('provider-connection-advanced');
}
