import type {
    AccountApiTokenSummaryV1,
    AccountApiTokensUpdateActionInputV1,
    ApiTokenGrantV1,
    ProviderBoundModelRef,
} from '@happier-dev/protocol';
import {
    buildEmbedParentGrantV1,
    deriveEmbedAccessFromGrantV1,
    type EmbedAccessV1,
    type EmbedConfigV1,
} from '@happier-dev/protocol/embed';

import { areApiTokenGrantsEqual } from '@/components/settings/apiTokens/grant/apiTokenGrantDraft';

/**
 * What Settings → Embeds edits. `access` is the enforced half, projected from and back into the one
 * parent grant (`deriveEmbedAccessFromGrantV1` / `buildEmbedParentGrantV1`); `config` is the embed's
 * presentation, listing organization and style. There is no third copy of either.
 */
export type EmbedDraft = Readonly<{
    label: string;
    access: EmbedAccessV1;
    config: EmbedConfigV1;
}>;

export type EmbedCreateBinding = Readonly<{ machineId: string; agentTargetKey: string }>;

/**
 * A new embed: can send, cannot approve, any model, the default permission mode only (so a browser
 * cannot skip the approvals the owner kept), no sites yet, no session creation.
 */
export const DEFAULT_EMBED_DRAFT: EmbedDraft = Object.freeze({
    label: '',
    access: Object.freeze({
        send: true,
        approve: false,
        changeModel: false,
        models: null,
        permissionModes: ['default'],
        sites: [],
        create: null,
    }),
    config: Object.freeze({
        v: 1,
        ui: { attachments: true },
        newChat: null,
        organization: { folderId: null, tagIds: [] },
        style: null,
    }),
}) as EmbedDraft;

export function readEmbedDraft(summary: AccountApiTokenSummaryV1): EmbedDraft {
    return {
        label: summary.label,
        access: deriveEmbedAccessFromGrantV1(summary.grant),
        config: summary.embedConfig ?? DEFAULT_EMBED_DRAFT.config,
    };
}

/**
 * Session creation is one decision: `null` removes the creation grant and the new-chat choice with
 * it (the embed can then only show chats that exist). The placement is always the organization's.
 */
export function setEmbedSessions(draft: EmbedDraft, binding: EmbedCreateBinding | null): EmbedDraft {
    return {
        ...draft,
        access: {
            ...draft.access,
            create: binding === null ? null : {
                machineId: binding.machineId,
                agentTargetKey: binding.agentTargetKey,
                directory: 'managed',
                placement: draft.config.organization,
            },
        },
        config: binding === null ? { ...draft.config, newChat: null } : draft.config,
    };
}

/** The new-chat composer is a host choice that needs session creation; without it the choice stays off. */
export function setEmbedNewChat(draft: EmbedDraft, enabled: boolean): EmbedDraft {
    const newChat = draft.access.create !== null && enabled ? { enabled: true } : null;
    return { ...draft, config: { ...draft.config, newChat } };
}

/** A draft that cannot become a grant yet: "only these models" with none chosen. */
export function readEmbedDraftIssue(draft: EmbedDraft): 'models_required' | null {
    return draft.access.models !== null && draft.access.models.length === 0 ? 'models_required' : null;
}

export function buildEmbedGrant(draft: EmbedDraft): ApiTokenGrantV1 {
    return buildEmbedParentGrantV1(draft.access, draft.config);
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether saving the draft rebuilds the grant, which signs out open chats (they reconnect). */
export function isEmbedEnforcedEdit(original: AccountApiTokenSummaryV1, draft: EmbedDraft): boolean {
    if (readEmbedDraftIssue(draft)) return false;
    return !areApiTokenGrantsEqual(original.grant, buildEmbedGrant(draft));
}

/**
 * The smallest update: the label if renamed, the grant only when the enforced options changed (a
 * grant change revokes the embed's children), the configuration only when it changed. `null` when
 * nothing changed.
 */
export function buildEmbedUpdateInput(
    original: AccountApiTokenSummaryV1,
    draft: EmbedDraft,
): AccountApiTokensUpdateActionInputV1 | null {
    if (readEmbedDraftIssue(draft)) return null;
    const label = draft.label.trim();
    const update: {
        tokenId: string;
        label?: string;
        grant?: ApiTokenGrantV1;
        embedConfig?: EmbedConfigV1;
    } = { tokenId: original.tokenId };
    if (label !== original.label) update.label = label;
    if (isEmbedEnforcedEdit(original, draft)) update.grant = buildEmbedGrant(draft);
    if (!sameJson(original.embedConfig, draft.config)) update.embedConfig = draft.config;
    return Object.keys(update).length > 1 ? update : null;
}

export type EmbedSummaryPart =
    | Readonly<{ kind: 'sites'; count: number }>
    | Readonly<{ kind: 'viewOnly' }>
    | Readonly<{ kind: 'approve' }>
    | Readonly<{ kind: 'send' }>
    | Readonly<{ kind: 'sendAndApprove' }>
    | Readonly<{ kind: 'models'; models: readonly ProviderBoundModelRef[] }>
    | Readonly<{ kind: 'folder'; folderId: string }>;

/**
 * A row's facts in the fixed order of plan 04 §6.2: sites → can send / can approve → models →
 * folder. Quiet defaults (any model, no folder) are omitted.
 */
export function listEmbedSummaryParts(embed: Pick<AccountApiTokenSummaryV1, 'grant' | 'embedConfig'>): readonly EmbedSummaryPart[] {
    const access = deriveEmbedAccessFromGrantV1(embed.grant);
    const config = embed.embedConfig ?? DEFAULT_EMBED_DRAFT.config;
    const parts: EmbedSummaryPart[] = [{ kind: 'sites', count: access.sites.length }];
    // Send and Approve are independent grants: approval without Send is never "View only".
    if (access.send) parts.push({ kind: access.approve ? 'sendAndApprove' : 'send' });
    else parts.push({ kind: access.approve ? 'approve' : 'viewOnly' });
    if (access.models !== null) parts.push({ kind: 'models', models: access.models });
    if (config.organization.folderId !== null) parts.push({ kind: 'folder', folderId: config.organization.folderId });
    return parts;
}
