import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { useDocumentShareController, type DocumentAudienceShareResult } from '@/components/sharing/documents/useDocumentShareController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type ProfileChoice = string | null | undefined;
export type ApprovalProfileDefaultSaveResult =
    | Readonly<{ ok: true; shared: readonly PrincipalRefV1[] }>
    | Readonly<{ ok: false; phase: 'cancelled'; shared: readonly [] }>
    | (Extract<DocumentAudienceShareResult, { ok: false }> & Readonly<{ phase: 'sharing' }>)
    | Readonly<{ ok: false; phase: 'save'; shared: readonly PrincipalRefV1[]; error: unknown }>;

/** Team, Group and project defaults share the picked profile only after the person's choice.
 * The host's existing defaults writer owns saving; the Artifact owner decides missing audience. */
export function useApprovalProfileDefault(input: Readonly<{
    scope: ServerAccountScope | null;
    value: ProfileChoice;
    audience?: readonly PrincipalRefV1[];
    save(value: ProfileChoice): Promise<void>;
}>) {
    const [draft, setDraft] = React.useState<Readonly<{ value: ProfileChoice; save: typeof input.save;
        scope: ServerAccountScope | null; audience: readonly PrincipalRefV1[] | undefined }> | null>(null);
    const needsReview = draft !== null && typeof draft.value === 'string' && Boolean(draft.audience?.length);
    const sharing = useDocumentShareController(needsReview && draft?.scope && typeof draft.value === 'string'
        ? { scope: draft.scope, artifactId: draft.value, kind: 'approval-profile.v1', requestedAudience: draft.audience } : null);
    const choose = React.useCallback((value: ProfileChoice) => {
        if (value === input.value) return;
        setDraft({ value, save: input.save, scope: input.scope, audience: input.audience });
    }, [input.value, input.save, input.scope, input.audience]);
    const submit = React.useCallback(async (decision: 'share' | 'save_only' | 'cancel'): Promise<ApprovalProfileDefaultSaveResult> => {
        if (!draft || decision === 'cancel') {
            setDraft(null);
            return { ok: false, phase: 'cancelled', shared: [] };
        }
        let shared: readonly PrincipalRefV1[] = [];
        if (decision === 'share' && needsReview) {
            const result = await sharing.shareMissingAudience();
            if (!result.ok) return { ...result, phase: 'sharing' };
            shared = result.shared;
        }
        try {
            await draft.save(draft.value);
            setDraft(current => current === draft ? null : current);
            return { ok: true, shared };
        } catch (error) { return { ok: false, phase: 'save', shared, error }; }
    }, [draft, needsReview, sharing.shareMissingAudience]);
    return { value: input.value, draft: draft ? { value: draft.value } : null, choose, submit,
        review: { required: needsReview, missingAudience: sharing.missingAudience,
            loading: needsReview && sharing.loading, issue: needsReview ? sharing.issue : undefined, retry: sharing.retryContent } };
}
