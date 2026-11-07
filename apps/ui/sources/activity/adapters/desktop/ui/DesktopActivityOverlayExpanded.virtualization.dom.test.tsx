// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installClampedWebScrollGeometry } from '@/dev/testkit/legend/webScrollGeometry';
import type { BotFaceSnapshot } from '../presentation/notchBotTypes';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { DesktopActivityOverlayExpandedCards } from './cards/DesktopActivityOverlayExpandedCards';
import { DesktopActivityOverlayExpanded } from './DesktopActivityOverlayExpanded';
import type { DesktopActivityOverlayExpandedCard } from './shared/desktopActivityOverlayUiModel';
import { resolveDesktopActivityOverlayCardActionInstanceTestID } from './shared/desktopActivityOverlaySelectors.mjs';
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const harness = createWebListDomHarness({ rowSelector: '[data-testid^="desktop-activity-overlay-bot-row-"][role="button"]', rowHeight: 48 });
beforeEach(() => {
    // Canvas rasterization is a browser graphics boundary; layout and the list engine stay real.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
describe('DesktopActivityOverlayExpanded viewport mounting', () => {
    it('publishes the complete virtual content extent when only the viewport rows mount', async () => {
        const onContentSizeChange = vi.fn();
        await act(async () => harness.root.render(<div id="virtualized-list-host">
            <VirtualizedList data={Array.from({ length: 1001 }, (_, id) => ({ id }))}
                keyExtractor={item => String(item.id)} estimatedItemSize={48} getFixedItemSize={() => 48}
                onContentSizeChange={onContentSizeChange}
                renderItem={({ item }) => <div data-testid={`desktop-activity-overlay-bot-row-${item.id}`}>{item.id}</div>} />
        </div>));
        await harness.flush();
        expect(onContentSizeChange).toHaveBeenCalledWith(800, 1001 * 48);
    });
    it('keeps a short Bot list at its measured natural height within the available frame', async () => {
        const faces: BotFaceSnapshot[] = Array.from({ length: 2 }, (_, index) => ({
            sessionId: `short-${index}`, serverId: 'home-a', accountId: 'account-a', name: `Bot ${index}`,
            face: { seed: `face-${index}`, face: null }, activity: 'quiet', currentLine: null,
            meaningfulActivityAt: 0, live: false, agentId: null, machineId: null,
        }));
        const onNaturalHeight = vi.fn();
        await act(async () => harness.root.render(<div id="virtualized-list-host">
            <DesktopActivityOverlayExpanded visualMode="floating_overlay" maxHeight={400} onNaturalHeight={onNaturalHeight}
                model={{ expanded: { title: 'Bots', rows: [], cards: [] } }} onOpenSession={() => {}}
                bots={{ faces, handlers: { onOpen: () => {}, onOpenIn: () => {} } }} />
        </div>));
        await harness.flush();
        const scroller = harness.container.querySelector<HTMLElement>('[data-testid="desktop-activity-overlay-expanded-scroll"]')!;
        const theme = createThemeFixture();
        const naturalContentHeight = faces.length * 48 + theme.space.s2;
        expect(Number.parseFloat(scroller.style.height)).toBe(naturalContentHeight);
        expect(onNaturalHeight).toHaveBeenLastCalledWith(naturalContentHeight + 2 * theme.space.s12);
    });
    it('mounts viewport Bots at scale and reaches the last Bot without dropping its open interaction', async () => {
        const faces: BotFaceSnapshot[] = Array.from({ length: 1001 }, (_, index) => ({
            sessionId: `bot-${index}`, serverId: 'home-a', accountId: 'account-a', name: `Bot ${index}`,
            face: { seed: `face-${index}`, face: null }, activity: 'quiet', currentLine: null,
            meaningfulActivityAt: 0, live: false, agentId: null, machineId: null,
        }));
        const onOpen = vi.fn();
        const onDismissKey = vi.fn();
        await act(async () => harness.root.render(
            <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                <DesktopActivityOverlayExpanded visualMode="floating_overlay" maxHeight={400} onDismissKey={onDismissKey}
                    model={{ expanded: { title: 'Bots', rows: [], cards: [] } }} onOpenSession={() => {}}
                    bots={{ faces, handlers: { onOpen, onOpenIn: () => {} } }} />
            </div>,
        ));
        await harness.flush();
        const mounted = () => harness.container.querySelectorAll('[data-testid^="desktop-activity-overlay-bot-row-"][role="button"]');
        const initialMounted = mounted().length;
        expect(mounted().length).toBeGreaterThan(0);
        expect(mounted().length).toBeLessThan(faces.length / 4);
        const first = harness.container.querySelector<HTMLElement>('[data-testid="desktop-activity-overlay-bot-row-bot-0"]')!;
        await act(async () => first.focus());
        const scroller = harness.container.querySelector<HTMLElement>('[data-testid="desktop-activity-overlay-expanded-scroll"]')!;
        installClampedWebScrollGeometry();
        await act(async () => { scroller.scrollTo({ top: scroller.scrollHeight }); });
        await harness.flush();
        console.info('F12 actual Bot rows', { inventory: faces.length, initialMounted, endMounted: mounted().length });
        expect(document.activeElement?.getAttribute('data-testid')).toBe(first.dataset.testid);
        const last = harness.container.querySelector<HTMLElement>('[data-testid="desktop-activity-overlay-bot-row-bot-1000"]');
        expect(last).not.toBeNull();
        await act(async () => { last!.click(); });
        expect(onOpen).toHaveBeenCalledWith(faces.at(-1));
        await act(async () => { last!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(onDismissKey).toHaveBeenCalledOnce();
        expect(mounted().length).toBeLessThan(faces.length / 4);
    });
    it('keeps an answered ask answered after its Bot leaves and returns to the viewport', async () => {
        const faces: BotFaceSnapshot[] = Array.from({ length: 1001 }, (_, index) => ({
            sessionId: `answer-${index}`, serverId: 'home-a', accountId: 'account-a', name: `Bot ${index}`,
            face: { seed: `face-${index}`, face: null }, activity: 'quiet', currentLine: null,
            meaningfulActivityAt: 0, live: false, agentId: null, machineId: null,
        }));
        const card = {
            id: 'permission-first', kind: 'permission_request', requestId: 'request-first',
            sessionId: faces[0].sessionId, serverId: faces[0].serverId,
            title: 'Edit file', summary: 'Approve edit', toolLabel: 'Agent asks', questionText: null, count: 1,
            openActionIdentifier: 'open-session', allowActionIdentifier: 'approve-permission', denyActionIdentifier: 'deny-permission', risk: 'low',
            actions: [{ id: 'allow', label: 'Allow', actionIdentifier: 'approve-permission', tone: 'primary' }],
        } satisfies Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' }>;
        const element = (cards: readonly DesktopActivityOverlayExpandedCard[]) => <div id="virtualized-list-host">
            <DesktopActivityOverlayExpanded visualMode="floating_overlay" maxHeight={400}
                model={{ expanded: { title: 'Bots', rows: [], cards } }} onOpenSession={() => {}} onAction={() => true}
                bots={{ faces, handlers: { onOpen: () => {}, onOpenIn: () => {} } }} />
        </div>;
        await act(async () => harness.root.render(element([card])));
        await harness.flush();
        const action = harness.container.querySelector<HTMLElement>(`[data-testid="${resolveDesktopActivityOverlayCardActionInstanceTestID(card.id, 'allow')}"]`)!;
        expect(action).not.toBeNull();
        await act(async () => action.click());
        const answered = () => harness.container.querySelector(`[data-testid="desktop-activity-overlay-card-answered-${card.id}"]`);
        expect(answered()).not.toBeNull();
        const scroller = harness.container.querySelector<HTMLElement>('[data-testid="desktop-activity-overlay-expanded-scroll"]')!;
        installClampedWebScrollGeometry();
        await act(async () => scroller.scrollTo({ top: scroller.scrollHeight }));
        await harness.flush();
        expect(harness.container.querySelector(`[data-testid="desktop-activity-overlay-bot-row-${faces[0].sessionId}"]`)).toBeNull();
        await act(async () => scroller.scrollTo({ top: 0 }));
        await harness.flush();
        expect(answered()).not.toBeNull();
        // Removing the canonical card retires its answer; a later inventory entry starts unanswered.
        await act(async () => harness.root.render(element([])));
        await harness.flush();
        await act(async () => harness.root.render(element([card])));
        await harness.flush();
        expect(answered()).toBeNull();
        expect(harness.container.querySelector(`[data-testid="${resolveDesktopActivityOverlayCardActionInstanceTestID(card.id, 'allow')}"]`)).not.toBeNull();
    });
    it('keeps an Other answer draft after its Bot leaves and returns to the viewport', async () => {
        const faces: BotFaceSnapshot[] = Array.from({ length: 1001 }, (_, index) => ({
            sessionId: `draft-${index}`, serverId: 'home-a', accountId: 'account-a', name: `Bot ${index}`,
            face: { seed: `face-${index}`, face: null }, activity: 'quiet', currentLine: null,
            meaningfulActivityAt: 0, live: false, agentId: null, machineId: null,
        }));
        const card = {
            id: 'question-first', kind: 'user_question', requestId: 'request-first',
            sessionId: faces[0].sessionId, serverId: faces[0].serverId,
            title: 'Where?', summary: 'Choose a target', toolLabel: 'Agent asks', questionText: 'Where?', count: 1,
            openActionIdentifier: 'open-session',
            actions: [{ id: 'other', label: 'Other', actionIdentifier: 'answer-user-question', tone: 'secondary', inputKind: 'inline_text' }],
        } satisfies Extract<DesktopActivityOverlayExpandedCard, { kind: 'user_question' }>;
        await act(async () => harness.root.render(<div id="virtualized-list-host">
            <DesktopActivityOverlayExpanded visualMode="floating_overlay" maxHeight={400}
                model={{ expanded: { title: 'Bots', rows: [], cards: [card] } }} onOpenSession={() => {}} onAction={() => true}
                bots={{ faces, handlers: { onOpen: () => {}, onOpenIn: () => {} } }} />
        </div>));
        await harness.flush();
        const other = harness.container.querySelector<HTMLElement>(`[data-testid="${resolveDesktopActivityOverlayCardActionInstanceTestID(card.id, 'other')}"]`)!;
        await act(async () => other.click());
        const input = () => harness.container.querySelector<HTMLInputElement>(`[data-testid="desktop-activity-overlay-question-other-input-${card.id}"]`);
        expect(input()).not.toBeNull();
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), 'Staging first');
            input()!.dispatchEvent(new Event('input', { bubbles: true }));
            input()!.blur();
        });
        expect(input()!.value).toBe('Staging first');
        const scroller = harness.container.querySelector<HTMLElement>('[data-testid="desktop-activity-overlay-expanded-scroll"]')!;
        installClampedWebScrollGeometry();
        await act(async () => scroller.scrollTo({ top: scroller.scrollHeight }));
        await harness.flush();
        expect(harness.container.querySelector(`[data-testid="desktop-activity-overlay-bot-row-${faces[0].sessionId}"]`)).toBeNull();
        await act(async () => scroller.scrollTo({ top: 0 }));
        await harness.flush();
        expect(input()?.value).toBe('Staging first');
    });
    it('keeps bounded inline actions scoped to their actual card identities and inventory lifetime', async () => {
        const cards = ['first', 'second'].map(id => ({
            id, kind: 'permission_request', requestId: id, sessionId: 'same-session', serverId: 'home-a',
            title: 'Edit file', summary: 'Approve edit', toolLabel: 'Agent asks', questionText: null, count: 1,
            openActionIdentifier: 'open-session', allowActionIdentifier: 'approve-permission', denyActionIdentifier: 'deny-permission', risk: 'low',
            actions: [{ id: 'allow', label: 'Allow', actionIdentifier: 'approve-permission', tone: 'primary' }],
        } satisfies Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' }>));
        const element = (inventory: readonly DesktopActivityOverlayExpandedCard[]) => <DesktopActivityOverlayExpandedCards
            visualMode="floating_overlay" model={{ expanded: { title: 'Conversation', rows: [], cards: inventory } }}
            onOpenSession={() => {}} onAction={() => true} />;
        await act(async () => harness.root.render(element(cards)));
        const action = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${resolveDesktopActivityOverlayCardActionInstanceTestID(id, 'allow')}"]`);
        await act(async () => action('first')!.click());
        expect(action('first')).toBeNull();
        expect(action('second')).not.toBeNull();
        await act(async () => harness.root.render(element([cards[1]])));
        await act(async () => harness.root.render(element(cards)));
        expect(action('first')).not.toBeNull();
    });

});
