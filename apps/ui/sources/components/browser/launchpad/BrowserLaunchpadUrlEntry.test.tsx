import * as React from 'react';
import { act } from 'react-test-renderer';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadOpenTargetOptions } from './BrowserLaunchpad';

async function submitInput(input: ReturnType<Awaited<ReturnType<typeof renderScreen>>['findByTestId']>): Promise<void> {
    await act(async () => {
        (input?.props as { onSubmitEditing?: () => void }).onSubmitEditing?.();
    });
}

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

describe('BrowserLaunchpadUrlEntry', () => {
    it('is disabled (does not navigate) when no in-place navigation seam is provided', async () => {
        const { BrowserLaunchpadUrlEntry } = await import('./BrowserLaunchpadUrlEntry');

        const screen = await renderScreen(
            <BrowserLaunchpadUrlEntry platform="desktop" testID="url-entry" />,
        );

        // Without the current-tab seam the field is non-editable and submit is a no-op (never a sibling tab).
        const input = screen.findByTestId('url-entry-input');
        expect((input?.props as { editable?: boolean }).editable).toBe(false);
    });

    it('DV-NAV: normalizes a typed address into an externalUrl target and navigates the CURRENT tab in place', async () => {
        const { BrowserLaunchpadUrlEntry } = await import('./BrowserLaunchpadUrlEntry');
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpadUrlEntry
                platform="desktop"
                onNavigateInPlace={onNavigateInPlace}
                testID="url-entry"
            />,
        );

        screen.changeTextByTestId('url-entry-input', 'https://example.test/app');
        await submitInput(screen.findByTestId('url-entry-input'));

        expect(onNavigateInPlace).toHaveBeenCalledTimes(1);
        const [target, options] = onNavigateInPlace.mock.calls[0] as [BrowserViewTargetV1, BrowserLaunchpadOpenTargetOptions | undefined];
        expect(target.kind).toBe('externalUrl');
        expect(target.kind === 'externalUrl' ? target.url : null).toBe('https://example.test/app');
        expect(options?.platform).toBe('desktop');
    });

    it('infers https:// for a bare host so a one-word address still opens', async () => {
        const { BrowserLaunchpadUrlEntry } = await import('./BrowserLaunchpadUrlEntry');
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpadUrlEntry
                platform="desktop"
                onNavigateInPlace={onNavigateInPlace}
                testID="url-entry"
            />,
        );

        screen.changeTextByTestId('url-entry-input', 'example.test');
        await submitInput(screen.findByTestId('url-entry-input'));

        expect(onNavigateInPlace).toHaveBeenCalledTimes(1);
        const [target] = onNavigateInPlace.mock.calls[0] as [BrowserViewTargetV1];
        expect(target.kind === 'externalUrl' ? target.url : null).toBe('https://example.test/');
    });

    it('does not delegate (and surfaces an invalid affordance) when the address is unparseable', async () => {
        const { BrowserLaunchpadUrlEntry } = await import('./BrowserLaunchpadUrlEntry');
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpadUrlEntry
                platform="desktop"
                onNavigateInPlace={onNavigateInPlace}
                testID="url-entry"
            />,
        );

        screen.changeTextByTestId('url-entry-input', 'not a url at all');
        // Drive submit through the open button so the invalid-state update is flushed (act-wrapped).
        await screen.pressByTestIdAsync('url-entry-open');

        expect(onNavigateInPlace).not.toHaveBeenCalled();
        expect(screen.findByTestId('url-entry-invalid')).toBeTruthy();
    });

    it('ignores an empty submit without surfacing an error', async () => {
        const { BrowserLaunchpadUrlEntry } = await import('./BrowserLaunchpadUrlEntry');
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpadUrlEntry
                platform="desktop"
                onNavigateInPlace={onNavigateInPlace}
                testID="url-entry"
            />,
        );

        await submitInput(screen.findByTestId('url-entry-input'));

        expect(onNavigateInPlace).not.toHaveBeenCalled();
        expect(screen.findByTestId('url-entry-invalid')).toBeNull();
    });
});
