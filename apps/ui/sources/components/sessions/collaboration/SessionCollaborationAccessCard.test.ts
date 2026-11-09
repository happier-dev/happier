import { describe, expect, it } from 'vitest';

import type { SessionAccessEditorModel, SessionAccessGrantRowModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import { projectSessionCollaborationAccessCard } from './SessionCollaborationAccessCard';

function grant(name: string, kind: 'account' | 'team' = 'account'): SessionAccessGrantRowModel {
    const ref = kind === 'account' ? { kind: 'account' as const, accountId: name } : { kind: 'team' as const, teamId: name };
    return {
        grant: ref,
        principal: { ref, key: `${kind}:${name}`, displayName: name, accessibilityLabel: name },
        level: { kind: 'editable', value: 'view', options: [] },
        permissionDelegation: { kind: 'hidden' },
        removal: { kind: 'allowed' },
        requiredByTeamPolicy: false,
        operation: { kind: 'idle' },
    } as unknown as SessionAccessGrantRowModel;
}

function model(overrides: Partial<SessionAccessEditorModel> = {}): SessionAccessEditorModel {
    return {
        revision: 1,
        accessMode: 'editable',
        content: { phase: 'ready', hasLastAcknowledgedSnapshot: true },
        owner: null,
        grants: [],
        directory: { sections: [] },
        summary: { label: 'Access', accessibilityLabel: 'Access', requiredByTeamPolicy: false },
        ...overrides,
    };
}

describe('projectSessionCollaborationAccessCard', () => {
    it('names who has access the way the lab reads it', () => {
        const card = projectSessionCollaborationAccessCard({
            model: model({ grants: [grant('Ana'), grant('Ben'), grant('Platform', 'team')] }),
            publicLinkOn: true,
        });
        expect(card).toMatchObject({ state: 'ready', title: 'Ana, Ben and Platform', subtitle: 'Have access', publicLinkOn: true, notShared: false });
        expect(card.principals).toHaveLength(3);
    });

    it('folds a longer audience into a count and keeps three marks', () => {
        const card = projectSessionCollaborationAccessCard({
            model: model({ grants: ['Ana', 'Ben', 'Mei', 'Kai', 'Lu'].map((name) => grant(name)) }),
            publicLinkOn: false,
        });
        expect(card.title).toBe('Ana, Ben and 3 more');
        expect(card.principals).toHaveLength(3);
    });

    it('says a single person has access', () => {
        expect(projectSessionCollaborationAccessCard({ model: model({ grants: [grant('Ana')] }), publicLinkOn: false }))
            .toMatchObject({ title: 'Ana', subtitle: 'Has access' });
    });

    it('invites sharing only for a manager whose Session is shared with nobody yet', () => {
        expect(projectSessionCollaborationAccessCard({ model: model(), publicLinkOn: false }))
            .toMatchObject({ title: 'Only you', notShared: true });
        expect(projectSessionCollaborationAccessCard({ model: model({ accessMode: 'read_only' }), publicLinkOn: false }).notShared).toBe(false);
    });

    it('shows a collaborator their own access, never the private roster', () => {
        const card = projectSessionCollaborationAccessCard({
            model: model({
                accessMode: 'read_only',
                viewerAccess: { level: 'edit', levelLabel: 'You can edit', sourceLabels: ['Platform'], accessibilityLabel: 'You can edit' },
                summary: { label: 'Platform', accessibilityLabel: 'Platform', requiredByTeamPolicy: false },
            }),
            publicLinkOn: false,
        });
        expect(card).toMatchObject({ title: 'Platform', subtitle: 'You can edit', notShared: false });
    });

    it('keeps its line while the roster is read, and says when it could not be', () => {
        expect(projectSessionCollaborationAccessCard({
            model: model({ content: { phase: 'initial', hasLastAcknowledgedSnapshot: false } }),
            publicLinkOn: false,
        })).toMatchObject({ state: 'loading', subtitle: 'Checking who has access…' });
        expect(projectSessionCollaborationAccessCard({
            model: model({ content: { phase: 'error', hasLastAcknowledgedSnapshot: false } }),
            publicLinkOn: false,
        })).toMatchObject({ state: 'error', subtitle: 'Couldn’t load who has access' });
    });
});
