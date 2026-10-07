import { z } from 'zod';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { EmbedConfigV1Schema } from '@happier-dev/protocol/embed';

import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

import type { ApiTokenSettingsState } from './apiTokenSettingsController';

/**
 * Restoring encryption access leaves the token page (`/restore/manual`) and comes back with the
 * create draft in the URL. The draft is non-secret (label, expiry, access, grant, embed
 * configuration), so the whole of it travels; nothing is inferred from a missing field. A draft that
 * does not parse does not resume at all, rather than resuming as Full access.
 */

/** Where a resumed create lands: the token list (its create modal) or the embed create page. */
export const API_TOKEN_CREATE_RESUME_RETURN_PATHS = Object.freeze([
    '/settings/account/api-tokens',
    '/settings/embeds/new',
] as const);
export type ApiTokenCreateResumeReturnPath = (typeof API_TOKEN_CREATE_RESUME_RETURN_PATHS)[number];

export type ApiTokenCreateResumeTarget = Readonly<{
    targetServerId: string;
    targetServerUrl: string;
    expectedAccountId: string;
}>;

type CreateDraft = ApiTokenSettingsState['createDraft'];

const CreateDraftResumeSchema = z.object({
    label: z.string().max(256),
    expiryPreset: z.enum(['30d', '90d', '1y', 'none']),
    encryptionAccess: z.boolean().optional(),
    authorizeUnattendedTeamAccess: z.boolean().optional(),
    access: z.enum(['full', 'limited']),
    grant: ApiTokenGrantV1Schema.optional(),
    embedConfig: EmbedConfigV1Schema.optional(),
}).strict().superRefine((draft, context) => {
    // A limited draft is only its grant: without one it cannot resume as anything honest.
    if (draft.access === 'limited' && draft.grant === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['grant'], message: 'A limited draft carries its grant.' });
    }
    if (draft.embedConfig !== undefined && draft.access !== 'limited') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['embedConfig'], message: 'An embed draft is limited.' });
    }
});

export function isApiTokenCreateResumeReturnPath(path: string | null): path is ApiTokenCreateResumeReturnPath {
    return path !== null && (API_TOKEN_CREATE_RESUME_RETURN_PATHS as readonly string[]).includes(path);
}

function buildResumeQuery(draft: CreateDraft, target: ApiTokenCreateResumeTarget): string {
    const serialized = JSON.stringify({ ...draft, access: draft.access ?? 'full', label: draft.label.trim().slice(0, 256) });
    return `resumeCreate=1&draft=${encodeURIComponent(serialized)}`
        + `&targetServerId=${encodeURIComponent(target.targetServerId)}`
        + `&targetServerUrl=${encodeURIComponent(target.targetServerUrl)}`
        + `&expectedAccountId=${encodeURIComponent(target.expectedAccountId)}`;
}

/** The route a resumed create returns to, carrying the complete non-secret draft and its exact target. */
export function buildApiTokenCreateResumePath(
    returnTo: ApiTokenCreateResumeReturnPath,
    draft: CreateDraft,
    target: ApiTokenCreateResumeTarget,
): string {
    return `${returnTo}?${buildResumeQuery(draft, target)}`;
}

/** The secret-key restore bound to the exact Home and Account, returning to `returnTo` with the draft. */
export function buildApiTokenCreateRestorePath(
    returnTo: ApiTokenCreateResumeReturnPath,
    draft: CreateDraft,
    target: ApiTokenCreateResumeTarget,
): string {
    return `/restore/manual?returnTo=${encodeURIComponent(returnTo)}&${buildResumeQuery(draft, target)}`;
}

type RouteParam = string | string[] | undefined;
const first = (value: RouteParam): string => String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();

export type ApiTokenCreateResume = Readonly<{ draft: CreateDraft; target: ApiTokenCreateResumeTarget }>;

/** The resumed draft and its target, or `null` when the URL carries no complete, valid resume. */
export function readApiTokenCreateResume(params: Readonly<Record<string, RouteParam>>): ApiTokenCreateResume | null {
    if (first(params.resumeCreate) !== '1') return null;
    const target = {
        targetServerId: first(params.targetServerId),
        targetServerUrl: first(params.targetServerUrl),
        expectedAccountId: first(params.expectedAccountId),
    };
    if (!target.targetServerId || !target.targetServerUrl || !target.expectedAccountId) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(first(params.draft));
    } catch {
        return null;
    }
    const parsed = CreateDraftResumeSchema.safeParse(raw);
    return parsed.success ? { draft: parsed.data, target } : null;
}

/** The query keys a resume adds, cleared once it has been consumed or refused. */
export const API_TOKEN_CREATE_RESUME_CLEARED_PARAMS = Object.freeze({
    resumeCreate: undefined,
    draft: undefined,
    targetServerId: undefined,
    targetServerUrl: undefined,
    expectedAccountId: undefined,
});

/**
 * A resume reopens creation only for the exact Account and Home it was started on (the active
 * scope and the active Home's URL); any other arrival drops it.
 */
export function isApiTokenCreateResumeForActiveAccount(
    resume: ApiTokenCreateResume,
    active: Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }> | null;
        server: Readonly<{ serverId: string; serverUrl: string | null | undefined }>;
    }>,
): boolean {
    const { target } = resume;
    return Boolean(active.scope
        && active.scope.serverId === target.targetServerId
        && active.scope.accountId === target.expectedAccountId
        && active.server.serverId === target.targetServerId
        && createServerUrlComparableKey(String(active.server.serverUrl ?? '')) === createServerUrlComparableKey(target.targetServerUrl));
}
