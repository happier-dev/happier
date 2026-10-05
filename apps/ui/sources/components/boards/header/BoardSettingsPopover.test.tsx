import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkBoardItemKeyV1, createWorkBoardV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { BoardCard } from '../model/boardCards';
import { BoardSettingsButton } from './BoardSettingsPopover';

afterEach(standardCleanup);

// The renderer has no layout engine; only the physical anchor is supplied.
const layout = { createNodeMock: () => ({
    getBoundingClientRect: () => ({ left: 100, top: 50, right: 180, bottom: 82, width: 80, height: 32 }),
    measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(100, 50, 80, 32),
}) };

describe('Board settings picked items', () => {
    it('keeps settings short and removes picks through a separate navigable list', async () => {
        const cards: BoardCard[] = Array.from({ length: 40 }, (_, index) => {
            const ref = { kind: 'workflow' as const, qualifiedId: { serverId: 'home', id: `w${index}` } };
            return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, availability: 'ready', title: `Workflow ${index}`,
                status: { bucket: 'idle', tone: 'neutral', word: 'Idle' }, body: { kind: 'none' } };
        });
        const remove = vi.fn();
        const screen = await renderScreen(<BoardSettingsButton
            board={{ ...createWorkBoardV1({ id: 'board', name: 'Board' }), source: { picked: cards.map(card => card.ref) } }}
            homes={{ activeServerId: null, mountedServerIds: [], isHomeMounted: () => false }}
            pickedCards={cards} canvasAvailable dispatch={() => {}} onRemoveItem={remove}
            onDeleted={() => {}} open onOpenChange={() => {}} onAddByHand={() => {}}
        />, layout);
        expect(Boolean(screen.findHostByTestId('board-settings.name'))).toBe(true);
        const summary = screen.findHostByTestId('board-settings.picks:settings:option:picks');
        expect(Boolean(summary)).toBe(true);
        expect(screen.findHostByTestId(`board-settings.remove.${cards[0]!.key}`)).toBeNull();
        expect(screen.findHostByTestId('board-settings.snap')).not.toBeNull();
        expect(screen.findHostByTestId('board-settings.pin')).not.toBeNull();
        expect(screen.findHostByTestId('board-settings.delete')).not.toBeNull();
        await screen.pressByTestIdAsync('board-settings.picks:settings:option:picks');
        await screen.pressByTestIdAsync(`board-settings.remove.${cards[39]!.key}`);
        expect(remove).toHaveBeenCalledWith(cards[39]!.ref);
        await screen.pressByTestIdAsync('board-settings.picks:header:leading:back-chip');
        expect(screen.findHostByTestId('board-settings.delete')).not.toBeNull();
    });
});
