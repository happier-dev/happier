import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import {
    notifySessionComposerPresentationTargetChanged,
    registerSessionComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { useSessionBoardComposerSuggestion } from './useSessionBoardComposerSuggestion';

const SUGGESTION = 'Put something on this board that shows ';
const ADDRESS: SessionAddress = { serverId: 'home-1', sessionId: 'session-1' };

type FakeComposer = Readonly<{
    read: () => string;
    focused: () => number;
    unregister: () => void;
}>;

function mountComposer(input: Readonly<{
    address: SessionAddress;
    text?: string;
    editable?: boolean;
}>): FakeComposer {
    let text = input.text ?? '';
    let revision = 1;
    let focused = 0;
    const snapshot = (): ComposerSnapshotV1 => ({
        revision,
        ref: { kind: 'session', sessionId: input.address.sessionId },
        text,
        references: [],
        attachments: [],
        layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: {
            focused: false,
            editable: input.editable ?? true,
            submittable: true,
            submitting: false,
            running: false,
        },
    } as unknown as ComposerSnapshotV1);
    const unregister = registerSessionComposerPresentationTarget(input.address, {
        readRevision: () => revision,
        replace: (next, expectedRevision) => {
            if (expectedRevision !== revision) return revision;
            text = next;
            revision += 1;
            return revision;
        },
        readSnapshot: snapshot,
        focusComposer: () => { focused += 1; return true; },
    });
    return { read: () => text, focused: () => focused, unregister };
}

describe('useSessionBoardComposerSuggestion', () => {
    afterEach(() => { standardCleanup(); });

    it('is absent until this exact Home/Session has a mounted composer', async () => {
        const hook = await renderHook(() => useSessionBoardComposerSuggestion(ADDRESS));
        expect(hook.getCurrent()).toBeNull();

        let composer!: FakeComposer;
        await act(async () => {
            composer = mountComposer({ address: ADDRESS });
            notifySessionComposerPresentationTargetChanged(ADDRESS.sessionId);
        });
        expect(hook.getCurrent()).toBeTypeOf('function');

        composer.unregister();
    });

    it('offers an editable suggestion without sending, overwriting or duplicating it', async () => {
        const composer = mountComposer({ address: ADDRESS, text: 'Ship the release notes' });
        const hook = await renderHook(() => useSessionBoardComposerSuggestion(ADDRESS));

        await act(async () => { hook.getCurrent()?.(); });
        expect(composer.read()).toBe(`Ship the release notes\n\n${SUGGESTION}`);
        expect(composer.focused()).toBe(1);

        // Pressing again re-focuses the same invitation rather than stacking it.
        await act(async () => { hook.getCurrent()?.(); });
        expect(composer.read()).toBe(`Ship the release notes\n\n${SUGGESTION}`);
        expect(composer.focused()).toBe(2);

        composer.unregister();
    });

    it('never writes behind a composer the person cannot currently edit', async () => {
        const composer = mountComposer({ address: ADDRESS, text: '', editable: false });
        const hook = await renderHook(() => useSessionBoardComposerSuggestion(ADDRESS));

        await act(async () => { hook.getCurrent()?.(); });

        expect(composer.read()).toBe('');
        composer.unregister();
    });

    it('never reaches another Home holding the same raw Session id', async () => {
        const other = mountComposer({ address: { serverId: 'home-2', sessionId: 'session-1' } });
        const hook = await renderHook(() => useSessionBoardComposerSuggestion(ADDRESS));

        expect(hook.getCurrent()).toBeNull();
        expect(other.read()).toBe('');
        other.unregister();
    });
});
