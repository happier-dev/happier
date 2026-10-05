import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { WidgetFrame } from './WidgetFrame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(() => {
    standardCleanup();
});

async function renderFrame(props: Partial<React.ComponentProps<typeof WidgetFrame>> = {}) {
    const screen = await renderScreen(
        <WidgetFrame
            testID="frame"
            frameStyle="card"
            placement="home"
            mark="timer"
            title="Latest runs"
            source="Automations"
            body={{ kind: 'content', children: 'rows:here' }}
            {...props}
        />,
    );
    await flushHookEffects({ cycles: 2 });
    return screen;
}

describe('WidgetFrame', () => {
    it('draws the header at once — title, source, freshness and the section menu — around the body', async () => {
        const screen = await renderFrame({ meta: 'As of 10:42', menu: 'menu:here' });
        const text = screen.getTextContent();
        expect(text).toContain('Latest runs');
        expect(text).toContain('Automations');
        expect(text).toContain('As of 10:42');
        expect(text).toContain('menu:here');
        expect(text).toContain('rows:here');
    });

    it('reserves skeleton rows while the first read is pending, and shows no content', async () => {
        const screen = await renderFrame({ body: { kind: 'loading', accessibilityLabel: 'Loading latest runs' } });
        expect(screen.findByTestId('frame.loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('rows:here');
        // The header is not waiting on the data.
        expect(screen.getTextContent()).toContain('Latest runs');
    });

    it('explains an empty widget with what will appear there', async () => {
        const screen = await renderFrame({
            body: { kind: 'empty', title: 'No runs yet', reason: 'Runs of your automations show up here.' },
        });
        expect(screen.findByTestId('frame.empty')).toBeTruthy();
        expect(screen.getTextContent()).toContain('No runs yet');
        expect(screen.getTextContent()).toContain('Runs of your automations show up here.');
    });

    it('names a failure in the person\'s terms and offers the one fixing action', async () => {
        const retry = vi.fn();
        const screen = await renderFrame({
            body: {
                kind: 'error',
                title: 'Couldn\'t load runs',
                reason: 'Check the connection to your Home.',
                action: { label: 'Try again', onPress: retry },
                diagnosticCode: 'automations_refresh_failed',
            },
        });
        expect(screen.getTextContent()).toContain('Couldn\'t load runs');
        await act(async () => { screen.pressByTestId('frame.error-action'); });
        await flushHookEffects({ cycles: 2 });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('leads to the widget\'s destination from its one footer row', async () => {
        const open = vi.fn();
        const screen = await renderFrame({ footer: { kind: 'open', label: 'Open Automations', onPress: open } });
        expect(screen.getTextContent()).toContain('Open Automations');
        screen.pressByTestId('frame.open');
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('keeps last-known rows when a refresh fails, and says why in the footer with Retry instead of Open', async () => {
        const retry = vi.fn();
        const screen = await renderFrame({
            footer: { kind: 'refreshFailed', reason: 'Couldn\'t refresh', onRetry: retry },
        });
        expect(screen.getTextContent()).toContain('rows:here');
        expect(screen.getTextContent()).toContain('Couldn\'t refresh');
        expect(screen.findByTestId('frame.open')).toBeNull();
        screen.pressByTestId('frame.stale-action');
        expect(retry).toHaveBeenCalledTimes(1);
    });
    it('rings a widget that just arrived, and draws no ring otherwise', async () => {
        const fresh = await renderFrame({ placement: 'board', fresh: true });
        expect(fresh.findByTestId('widget-frame.arrival-ring')).toBeTruthy();
        standardCleanup();
        const settled = await renderFrame({ placement: 'board' });
        expect(settled.findByTestId('widget-frame.arrival-ring')).toBeNull();
    });

    it('keeps the same header, body and footer when drawn plain', async () => {
        const open = vi.fn();
        const screen = await renderFrame({
            frameStyle: 'plain',
            placement: 'companion',
            meta: '2 running',
            footer: { kind: 'open', label: 'Review changes', onPress: open },
        });
        const text = screen.getTextContent();
        for (const part of ['Latest runs', 'Automations', '2 running', 'rows:here', 'Review changes']) {
            expect(text).toContain(part);
        }
        screen.pressByTestId('frame.open');
        expect(open).toHaveBeenCalledTimes(1);
    });
});
