import { describe, expect, it } from 'vitest';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol';
import { buildEmbedParentGrantV1, deriveEmbedAccessFromGrantV1 } from '@happier-dev/protocol/embed';

import {
    DEFAULT_EMBED_DRAFT,
    buildEmbedGrant,
    buildEmbedUpdateInput,
    listEmbedSummaryParts,
    readEmbedDraft,
    readEmbedDraftIssue,
    setEmbedNewChat,
    setEmbedSessions,
    type EmbedDraft,
} from './embedDraft';

const MODEL = { agentTargetKey: 'agent:claude/claude', providerConnectionId: null, modelId: 'claude-sonnet-4-5' } as const;
const CREATE = { machineId: 'machine-1', agentTargetKey: 'agent:claude/claude' } as const;

function draft(overrides: Partial<EmbedDraft> = {}): EmbedDraft {
    return {
        ...DEFAULT_EMBED_DRAFT,
        label: 'Leads dashboard',
        access: { ...DEFAULT_EMBED_DRAFT.access, sites: ['https://crm.acme.dev'], send: true, approve: true, models: [MODEL] },
        config: { ...DEFAULT_EMBED_DRAFT.config, organization: { folderId: 'folder-leads', tagIds: ['tag-inbound'] } },
        ...overrides,
    };
}

function summaryFor(value: EmbedDraft): AccountApiTokenSummaryV1 {
    return {
        tokenId: '11111111-1111-4111-8111-111111111111',
        label: value.label,
        displayPrefix: 'hap_v1_1234abcd',
        createdAt: '2026-09-24T10:00:00.000Z',
        lastUsedAt: null,
        expiresAt: '2026-12-23T10:00:00.000Z',
        hasEncryptionAccess: false,
        hasUnattendedTeamAccess: false,
        grant: buildEmbedParentGrantV1(value.access, value.config),
        parentTokenId: null,
        activeChildCount: 0,
        embedConfig: value.config,
    };
}

describe('embed draft', () => {
    it('starts a new embed on the default permission mode only, so approvals the owner kept cannot be skipped', () => {
        expect(DEFAULT_EMBED_DRAFT.access.permissionModes).toEqual(['default']);
        // Stamped on the grant: a per-message mode override from the browser is refused unless allowed.
        expect(buildEmbedGrant({ ...DEFAULT_EMBED_DRAFT, access: { ...DEFAULT_EMBED_DRAFT.access, sites: ['https://crm.acme.dev'] } }).permissionModes).toEqual(['default']);
    });

    it('reads the enforced options from the grant, the rest from the embed configuration', () => {
        const original = draft();
        const read = readEmbedDraft(summaryFor(original));

        expect(read.access).toEqual(deriveEmbedAccessFromGrantV1(summaryFor(original).grant));
        expect(read.access).toMatchObject({ send: true, approve: true, models: [MODEL], sites: ['https://crm.acme.dev'] });
        expect(read.config).toEqual(original.config);
        expect(read.label).toBe('Leads dashboard');
    });

    it('creates the token with the one parent grant derivation and the embed configuration', () => {
        const value = setEmbedNewChat(setEmbedSessions(draft(), CREATE), true);

        const grant = buildEmbedGrant(value);

        expect(grant).toEqual(buildEmbedParentGrantV1(value.access, value.config));
        expect(grant.create?.placement).toEqual({ folderId: 'folder-leads', tagIds: ['tag-inbound'] });
        expect(grant.actions?.ids).toContain('session.spawn_new');
        expect(value.config.newChat).toEqual({ enabled: true });
    });

    it('sends only the configuration for presentation edits, including the new-chat choice', () => {
        const withSessions = setEmbedSessions(draft(), CREATE);
        const original = summaryFor(withSessions);

        const presentation = buildEmbedUpdateInput(original, {
            ...readEmbedDraft(original),
            config: { ...readEmbedDraft(original).config, ui: { attachments: false }, style: { v: 1, radius: 'round' } },
        });
        expect(presentation).toEqual({ tokenId: original.tokenId, embedConfig: expect.objectContaining({ ui: { attachments: false } }) });

        const newChat = buildEmbedUpdateInput(original, setEmbedNewChat(readEmbedDraft(original), true));
        expect(newChat).toEqual({ tokenId: original.tokenId, embedConfig: expect.objectContaining({ newChat: { enabled: true } }) });

        expect(buildEmbedUpdateInput(original, readEmbedDraft(original))).toBeNull();
    });

    it('rebuilds the grant for an access edit and for an organization edit while creation is on', () => {
        const original = summaryFor(setEmbedSessions(draft(), CREATE));
        const read = readEmbedDraft(original);

        const approveOff = buildEmbedUpdateInput(original, { ...read, access: { ...read.access, approve: false } });
        expect(approveOff?.grant).toEqual(buildEmbedParentGrantV1({ ...read.access, approve: false }, read.config));
        expect(approveOff).not.toHaveProperty('embedConfig');

        const moved = buildEmbedUpdateInput(original, { ...read, config: { ...read.config, organization: { folderId: null, tagIds: ['tag-inbound'] } } });
        expect(moved?.grant?.create?.placement).toEqual({ folderId: null, tagIds: ['tag-inbound'] });
    });

    it('turns sessions off as one decision: no creation grant and no new chats', () => {
        const on = setEmbedNewChat(setEmbedSessions(draft(), CREATE), true);
        const off = setEmbedSessions(on, null);

        expect(off.access.create).toBeNull();
        expect(off.config.newChat).toBeNull();
        expect(setEmbedNewChat(off, true).config.newChat).toBeNull();
        const grant = buildEmbedGrant(off);
        expect(grant.create).toBeNull();
        expect(grant.actions?.ids).not.toContain('session.spawn_new');
    });

    it('summarizes a row with only the facts that differ from quiet defaults, in a fixed order', () => {
        expect(listEmbedSummaryParts(summaryFor(draft())).map((part) => part.kind)).toEqual(['sites', 'sendAndApprove', 'models', 'folder']);
        const viewOnly = draft({ access: { ...DEFAULT_EMBED_DRAFT.access, sites: ['https://status.acme.dev'], send: false }, config: DEFAULT_EMBED_DRAFT.config });
        expect(listEmbedSummaryParts(summaryFor(viewOnly)).map((part) => part.kind)).toEqual(['sites', 'viewOnly']);
    });

    it('never calls approve-only access "View only": approval is its own granted fact', () => {
        const approveOnly = draft({ access: { ...DEFAULT_EMBED_DRAFT.access, sites: ['https://crm.acme.dev'], send: false, approve: true }, config: DEFAULT_EMBED_DRAFT.config });
        expect(deriveEmbedAccessFromGrantV1(buildEmbedGrant(approveOnly))).toMatchObject({ send: false, approve: true });
        expect(listEmbedSummaryParts(summaryFor(approveOnly)).map((part) => part.kind)).toEqual(['sites', 'approve']);
    });

    it('holds "only these models" with none chosen as an issue, never as a grant or an update', () => {
        const original = summaryFor(draft());
        const choosing = { ...readEmbedDraft(original), access: { ...readEmbedDraft(original).access, models: [] } };

        expect(readEmbedDraftIssue(choosing)).toBe('models_required');
        expect(buildEmbedUpdateInput(original, choosing)).toBeNull();
        expect(readEmbedDraftIssue(readEmbedDraft(original))).toBeNull();
    });
});
