import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionTerminalPage } from './SessionTerminalPage';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
// These HTTP operations are outside the Terminal journey; no encryption owner is mocked.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Terminal Jump unexpectedly reached the recipient-envelope API'); };
    return {
        createSessionDataKeyEnvelopeClient: unused,
        readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused,
        prepareSessionDataKeyEnvelopesDetached: unused,
    };
});
// This native package is unavailable in the source runner and does not render in this journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected native Markdown render in Terminal Jump'); },
}));
// With no connected machine fixture, the real terminal leaf reports a missing target instead of spawning.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: () => { throw new Error('A missing-target terminal must not reach machine RPC'); },
}));

describe('phone Terminal Jump and split admission', () => {
    afterEach(standardCleanup);

    it('opens grouped Jump directly from chip long press in the exact destination instance', async () => {
        const scopeId = createSessionPaneScopeId('jump-phone', 'home-a', 'second');
        const open = vi.fn();
        const screen = await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open, buildCommands: () => [] }}>
                <AppPaneProvider><SessionTerminalPage sessionId="jump-phone" scopeId={scopeId} testIdPrefix="term" /></AppPaneProvider>
            </UniversalSearchRuntimeProvider>,
        );
        const chip = screen.findAll((node) => node.props.testID === 'term-chip-embedded' && typeof node.props.onLongPress === 'function')[0];
        expect(chip).toBeTruthy();
        await act(async () => { chip!.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 120 } }); });
        expect(open).toHaveBeenCalledWith(undefined, undefined, { terminals: { scopeId } });
    });

    it('keeps tab verbs in overflow and disables Split without a measured split layout', async () => {
        const scopeId = createSessionPaneScopeId('split-phone', 'home-a', 'second');
        const screen = await renderScreen(
            <AppPaneProvider><SessionTerminalPage sessionId="split-phone" scopeId={scopeId} testIdPrefix="term" /></AppPaneProvider>,
        );
        await screen.pressByTestIdAsync('term-tab-menu');
        const menu = screen.findByType(DropdownMenu);
        expect((menu.props.items as Array<{ id: string }>).map((item) => item.id)).toEqual(expect.arrayContaining(['rename', 'splitRight', 'restart', 'close']));
        expect((menu.props.items as Array<{ id: string; disabled?: boolean }>).find((item) => item.id === 'splitRight')?.disabled).toBe(true);
    });
});
