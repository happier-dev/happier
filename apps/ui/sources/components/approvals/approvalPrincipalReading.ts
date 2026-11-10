import * as React from 'react';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { readSharePrincipalNames, useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';

function approvalPrincipal(reference: ApprovalActionReference | undefined): PrincipalRefV1 | null {
    if (reference?.kind === 'account') return { kind: 'account', accountId: reference.id };
    if (reference?.kind === 'team') return { kind: 'team', teamId: reference.id };
    if (reference?.kind === 'group') return { kind: 'group', teamId: reference.teamId, groupId: reference.id };
    return null;
}

/** Display and immediate consent read the exact principal through the existing authorized resolver. */
export async function readApprovalPrincipalName(reference: ApprovalActionReference | undefined, scope: ServerAccountScope,
    signal?: AbortSignal, isCurrent?: () => boolean): Promise<string | null> {
    const subject = approvalPrincipal(reference);
    if (!subject) return null;
    // An optional name never grants access; an unavailable identity keeps the approval's exact literal.
    const names = await readSharePrincipalNames([subject], scope, signal, isCurrent);
    return names.get(sharePrincipalKey(subject)) ?? null;
}

/** One exact read per mounted principal and credential lifetime, with no directory scan or render-driven refresh. */
export function useApprovalPrincipalName(reference: ApprovalActionReference | undefined, serverId: string | null): Readonly<{
    name: string | null; resolving: boolean;
}> {
    const subject = approvalPrincipal(reference);
    const key = subject ? sharePrincipalKey(subject) : null;
    // Keyed by the principal, not the reference object, so an equal reference does not re-read.
    const subjects = React.useMemo(() => (subject ? [subject] : null), [key]); // eslint-disable-line react-hooks/exhaustive-deps
    const { names, resolving } = useSharePrincipalNames(subjects, serverId);
    return { name: key && names ? names.get(key) ?? null : null, resolving };
}
