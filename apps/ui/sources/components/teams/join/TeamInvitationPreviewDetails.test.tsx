import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamInvitationPreviewV1 } from '@happier-dev/protocol/teams';

// The bundled first-party voice projection is a generated build artifact, not
// source. This join shell renders no voice surface, so it stays independent of
// that artifact the same way the Team settings shell tests do.
vi.mock('@/voice/registry/generatedBundledVoiceEntries', () => ({
    BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS: Object.freeze([]),
    BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS: Object.freeze([]),
}));

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { t, preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text';

import { TeamInvitationPreviewDetails } from './TeamInvitationPreviewDetails';

function activePreview(overrides: Partial<TeamInvitationPreviewV1> = {}): TeamInvitationPreviewV1 {
    return {
        home: { serverId: 'srv_acme', displayName: 'Acme Home', storageMode: null, hosting: null },
        team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
        role: 'member',
        historyAccess: 'from_membership',
        state: 'active',
        expiresAt: Date.UTC(2030, 0, 1),
        recipientEmailMask: null,
        inviterLabel: null,
        ...overrides,
    };
}

describe('TeamInvitationPreviewDetails', () => {
    it.each(['expired', 'revoked', 'used', 'team_archived'] as const)('renders the known %s reason and a fresh-link repair', async reason => {
        const { resolveTeamJoinPresentation } = await import('./teamJoinOutcome');
        const expected = resolveTeamJoinPresentation({ outcome: reason });
        const rendered = await renderScreen(<TeamInvitationPreviewDetails state={{ kind: 'unavailable', reason }} />);
        expect(rendered.findByTestId('team-join-preview-unavailable')).not.toBeNull();
        expect(rendered.getTextContent()).toContain(expected.title);
        expect(rendered.getTextContent()).toContain(t('teams.join.askForNew'));
    });
    it('keeps unknown bearers generic and names the Home repair for disabled Teams', async () => {
        const rendered = await renderScreen(<TeamInvitationPreviewDetails state={{ kind: 'unavailable' }} />);
        expect(rendered.getTextContent()).toContain(t('teams.join.invalidTitle'));
        await act(async () => { rendered.tree.update(<TeamInvitationPreviewDetails state={{ kind: 'unavailable', reason: 'teams_disabled' }} />); });
        expect(rendered.getTextContent()).toContain(t('teams.unavailable.disabled'));
        expect(rendered.getTextContent()).not.toContain(t('teams.join.askForNew'));
    });
    afterEach(async () => {
        setPreferredLanguageFromSettings(null);
        await standardCleanup();
    });

    it('names who invited you when the Home published a label for them', async () => {
        const rendered = await renderScreen(
            <TeamInvitationPreviewDetails
                state={{ kind: 'ready', preview: activePreview({ inviterLabel: 'Ada Lovelace' }) }}
            />,
        );

        const line = rendered.findByTestId('team-join-preview-inviter');
        expect(line).not.toBeNull();
        expect(rendered.getTextContent()).toContain('Ada Lovelace');
    });

    it('says nothing about the inviter when the Home published no label', async () => {
        const rendered = await renderScreen(
            <TeamInvitationPreviewDetails state={{ kind: 'ready', preview: activePreview() }} />,
        );

        // An inviter whose Account no longer resolves leaves the consequences the
        // Home did publish intact rather than showing an empty or placeholder line.
        expect(rendered.findByTestId('team-join-preview-inviter')).toBeNull();
        expect(rendered.findByTestId('team-join-preview-role')).not.toBeNull();
    });

    it('keeps published consequences visible with truthful refresh and retry status', async () => {
        const preview = activePreview({ role: 'guest', historyAccess: 'all_existing' });
        const onRetry = vi.fn();
        const rendered = await renderScreen(
            <TeamInvitationPreviewDetails state={{ kind: 'ready', preview, refreshing: true }} onRetry={onRetry} />,
        );
        expect(rendered.findByTestId('team-join-preview-role')).not.toBeNull();
        expect(rendered.findByTestId('team-join-preview-history')).not.toBeNull();
        expect(rendered.findByTestId('team-join-preview-refreshing')).not.toBeNull();

        await act(async () => {
            rendered.tree.update(
                <TeamInvitationPreviewDetails state={{ kind: 'ready', preview, refreshFailure: { retryable: true } }} onRetry={onRetry} />,
            );
        });
        expect(rendered.findByTestId('team-join-preview-role')).not.toBeNull();
        expect(rendered.findByTestId('team-join-preview-failed')).not.toBeNull();
        await rendered.pressByTestIdAsync('team-join-preview-failed-action');
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('formats invitation expiry in the selected app language', async () => {
        await preloadTranslationsForSettings('de');
        setPreferredLanguageFromSettings('de');
        const rendered = await renderScreen(
            <TeamInvitationPreviewDetails state={{ kind: 'ready', preview: activePreview() }} />,
        );
        // The Invitations page's calendar-date style: day and short month, with the year outside the current one.
        const expected = new Intl.DateTimeFormat('de', { day: 'numeric', month: 'short', year: 'numeric' })
            .format(new Date(Date.UTC(2030, 0, 1)));
        expect(rendered.getTextContent()).toContain(expected);
    });
});
