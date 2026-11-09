import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { t } from '@/text';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { applyTeamProjection, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';

import { LiveSessionAccessEditor } from './LiveSessionAccessEditor';
import {
    useSessionAccessComposerChip,
    type SessionAccessComposerChipParams,
} from './useSessionAccessComposerChip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Credential storage and the Team detail loader are the boundaries; the chip's
// own summary projection and Team snapshot reads stay real below them.
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: (serverId: string | null) => serverId
        ? { kind: 'bound', scope: { serverId, accountId: 'viewer' } }
        : { kind: 'unbound' },
}));
vi.mock('@/sync/engine/teams/teamsDirectoryEngine', () => ({ observeTeam: () => () => {} }));

type ProbeInput = Parameters<typeof useSessionAccessComposerChip>[0];
type EditorProps = React.ComponentProps<typeof LiveSessionAccessEditor>;

const TARGET: SessionAddress = { serverId: 'home-a', sessionId: 'session-1' };

async function mountProbe(initial: ProbeInput) {
    const seen: (SessionAccessComposerChipParams | null)[] = [];
    const setters: ((next: ProbeInput) => void)[] = [];

    function Probe() {
        const [input, setInput] = React.useState(initial);
        const [, bump] = React.useState(0);
        setters[0] = (next) => { setInput(next); bump((value) => value + 1); };
        seen.push(useSessionAccessComposerChip(input));
        return null;
    }

    await renderScreen(<Probe />);
    return {
        latest: () => seen[seen.length - 1] ?? null,
        /** Re-renders the host, by default without changing any chip input. */
        rerender: async (next?: ProbeInput) => {
            await act(async () => { setters[0]?.(next ?? initial); });
        },
    };
}

/**
 * The popover is supplied in the host's render form so Escape can drain the
 * editor's own sub-step before the overlay closes.
 */
function editorElement(
    params: SessionAccessComposerChipParams | null,
    requestClose: () => void = () => {},
): React.ReactElement<EditorProps> {
    const content = params?.popoverContent;
    if (typeof content !== 'function') throw new Error('Expected the chip to carry a popover render function');
    const rendered = content({ requestClose, maxHeight: 420 });
    if (!React.isValidElement(rendered)) throw new Error('Expected the chip to render an editor element');
    return rendered as React.ReactElement<EditorProps>;
}

afterEach(() => { standardCleanup(); resetTeamsSnapshotsForTests(); });

describe('useSessionAccessComposerChip', () => {
    it('withholds the chip only when this Session has no qualified target', async () => {
        const withoutTarget = await mountProbe({ target: null });
        expect(withoutTarget.latest()).toBeNull();
    });

    it('keeps the chip for every qualified Session so the editor explains an unavailable Home', async () => {
        // The draft composer keeps its recovery path in the same situation; a
        // disappearing chip would leave no way to learn why access is missing,
        // so availability is no longer an existence gate on this control.
        const probe = await mountProbe({ target: TARGET });
        expect(probe.latest()).not.toBeNull();
        expect(editorElement(probe.latest()).type).toBe(LiveSessionAccessEditor);
        expect(editorElement(probe.latest()).props.target).toEqual(TARGET);
    });

    it('prefers the Session Team context and carries its policy lock on the chip', async () => {
        applyTeamProjection({
            scope: { serverId: 'home-a', accountId: 'viewer' },
            address: { serverId: 'home-a', teamId: 'team-acme' },
            team: teamSummaryFixture({ id: 'team-acme', name: 'Acme' }),
            observedAt: 1,
        });

        const contextual = await mountProbe({
            target: TARGET,
            access: {
                role: 'owner', level: 'owner',
                capabilities: { manageAccess: true } as never,
                sources: [{ kind: 'owner' }],
                primaryTeamId: 'team-acme',
            },
        });
        expect(contextual.latest()?.label).toBe('Acme');

        const required = await mountProbe({
            target: TARGET,
            access: {
                role: 'recipient', level: 'edit',
                capabilities: { manageAccess: false } as never,
                sources: [{ kind: 'team', teamId: 'team-acme', requiredByTeamPolicy: true }],
                primaryTeamId: 'team-acme',
            },
        });
        expect(required.latest()?.label).toContain('Acme');
        expect(required.latest()?.label).toContain(t('session.access.required'));
        expect(required.latest()?.requiredByTeamPolicy).toBe(true);
        // A policy lock explains this viewer's access, not a differing audience.
        expect(required.latest()?.pending).not.toBe(true);

        const neutral = await mountProbe({ target: TARGET });
        expect(neutral.latest()?.label).toBe(t('session.access.title'));
        expect(neutral.latest()?.requiredByTeamPolicy).toBe(false);
        expect(contextual.latest()?.pending).not.toBe(true);
        expect(neutral.latest()?.pending).not.toBe(true);
    });

    it('hands the editor the real close and full-surface handoff from the popover host', async () => {
        const requestClose = vi.fn();
        const onOpenFullSurface = vi.fn();
        const probe = await mountProbe({ target: TARGET, onOpenFullSurface });

        const editor = editorElement(probe.latest(), requestClose);
        editor.props.onRequestClose?.();
        expect(requestClose).toHaveBeenCalledTimes(1);

        editor.props.onOpenFullSurface?.({ query: 'ada' });
        expect(onOpenFullSurface).toHaveBeenCalledTimes(1);
        // Closing the popover must not swallow what the person already typed.
        expect(onOpenFullSurface).toHaveBeenLastCalledWith({ query: 'ada' });
        // The anchored popover must not stay open behind the Collaboration surface.
        expect(requestClose).toHaveBeenCalledTimes(2);

        const anchoredOnly = await mountProbe({ target: TARGET });
        expect(editorElement(anchoredOnly.latest()).props.onOpenFullSurface).toBeUndefined();
    });

    it('keeps one chip identity while the composer re-renders around it', async () => {
        const probe = await mountProbe({ target: TARGET });
        const first = probe.latest();
        expect(first).not.toBeNull();

        await probe.rerender();
        await probe.rerender();

        // The transcript re-renders constantly. A fresh params object here would
        // rebuild every composer action chip on each of those renders.
        expect(probe.latest()).toBe(first);
    });

    it('binds the popover to the exact Session and rebuilds when that Session changes', async () => {
        const probe = await mountProbe({ target: TARGET });
        const first = probe.latest();
        expect(editorElement(first).type).toBe(LiveSessionAccessEditor);
        expect(editorElement(first).props).toEqual(expect.objectContaining({
            target: TARGET,
            presentation: 'compact',
        }));

        const next = { serverId: 'home-a', sessionId: 'session-2' };
        await probe.rerender({ target: next });

        expect(probe.latest()).not.toBe(first);
        expect(editorElement(probe.latest()).props.target).toEqual(next);
    });

    it('exposes the host handoff as the chip action only when the host supplies one', async () => {
        const onOpen = vi.fn();
        const handoff = await mountProbe({ target: TARGET, onOpen });
        handoff.latest()?.onOpen?.();
        expect(onOpen).toHaveBeenCalledTimes(1);

        const anchored = await mountProbe({ target: TARGET });
        expect(anchored.latest()?.onOpen).toBeUndefined();
    });
});
