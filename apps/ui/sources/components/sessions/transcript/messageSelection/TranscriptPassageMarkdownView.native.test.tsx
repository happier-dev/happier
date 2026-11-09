import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const { TranscriptPassageMarkdownView } = await import('./TranscriptPassageMarkdownView');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');

const source = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'session' }, messageId: 'committed' };
const markdown = [
    '1. **First group item**', '', 'Details for the first group item.', '',
    '1. **Second group item**', '', 'Details for the second group item.', '',
    'The restarted list is complete.',
].join('\n');

afterEach(standardCleanup);

describe('native transcript passage currentness', () => {
    it('routes both actions from normalized list prose and the following paragraph to the real account-admission owner', async () => {
        // No Account is mounted: a current selection must report that refusal, never vanish
        // in a renderer-coordinate guard. Scope admission and passage actions are not mocked.
        expect(captureActiveServerAccountScopeLifetime()).toBeNull();
        const screen = await renderScreen(<TranscriptPassageMarkdownView markdown={markdown}
            destinationSessionId="session" passageSource={source} />);
        for (const quote of ['Details for the first group item.', 'The restarted list is complete.']) {
            const run = screen.findAllByType('EnrichedMarkdownText').find(node => String(node.props.markdown).includes(quote));
            expect(run, quote).toBeDefined();
            for (const action of ['quote', 'annotate'] as const) {
                vi.mocked(Modal.alert).mockClear();
                const item = run!.props.contextMenuItems.find((menu: { text: string }) => menu.text === t(`transcriptPassage.${action}`));
                expect(item).toBeDefined();
                await act(async () => item.onPress({ text: quote, selection: { start: 0, end: quote.length } }));
                expect(Modal.alert, `${action}: ${quote}`).toHaveBeenCalledTimes(1);
            }
        }
    });

    it('keeps message, destination and Markdown-change checks for held native actions', async () => {
        const render = (text = 'Current prose.', destinationSessionId = 'session', passageSource = source) =>
            <TranscriptPassageMarkdownView markdown={text} destinationSessionId={destinationSessionId} passageSource={passageSource} />;
        const screen = await renderScreen(render());
        for (const changed of [render('Changed prose.'), render('Current prose.', 'other-destination'),
            render('Current prose.', 'session', { ...source, messageId: 'other-source' })]) {
            await screen.update(render());
            const held = screen.findByType('EnrichedMarkdownText').props.contextMenuItems;
            await screen.update(changed);
            vi.mocked(Modal.alert).mockClear();
            for (const item of held) {
                await act(async () => item.onPress({ text: 'Current prose.', selection: { start: 0, end: 14 } }));
            }
            expect(Modal.alert).not.toHaveBeenCalled();
        }
    });
});
