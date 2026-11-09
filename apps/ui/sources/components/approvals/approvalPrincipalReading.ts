import * as React from 'react';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { resolveSessionAccessPrincipals } from '@/sync/api/session/sessionAccessApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';

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
    try {
        const [principal] = await resolveSessionAccessPrincipals({ scope, subjects: [subject], availability: 'available', signal, isCurrent });
        if (!principal) return null;
        const presentation = presentSharePrincipal({ ref: subject, name: principal.name,
            ...(principal.kind === 'account' ? { profile: principal } : {}),
            ...(principal.kind === 'group' ? { teamName: principal.teamName } : {}), viewerAccountId: scope.accountId });
        return principal.kind === 'group' ? presentation.accessibilityLabel : presentation.displayName;
    } catch {
        // An optional name never grants access; an unavailable identity keeps the approval's exact literal.
        return null;
    }
}

/** One exact read per mounted principal and credential lifetime, with no directory scan or render-driven refresh. */
export function useApprovalPrincipalName(reference: ApprovalActionReference | undefined, serverId: string | null): Readonly<{
    name: string | null; resolving: boolean;
}> {
    const subject = approvalPrincipal(reference);
    const { binding, resolution } = useServerCredentialAccountScopeBinding(subject ? serverId : null);
    const key = JSON.stringify(subject);
    const currentReference = React.useRef(reference);
    currentReference.current = reference;
    const [reading, setReading] = React.useState<Readonly<{ binding: typeof binding; key: string; name: string | null }> | null>(null);
    React.useEffect(() => {
        if (!binding || key === 'null') return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        void readApprovalPrincipalName(currentReference.current, binding.scope, abort.signal, binding.isCurrent).then(name => {
            if (!abort.signal.aborted && binding.isCurrent()) setReading({ binding, key, name });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, key]);
    const current = reading?.binding === binding && reading.key === key && binding?.isCurrent() ? reading : null;
    return { name: current?.name ?? null, resolving: subject !== null
        && (resolution.kind === 'resolving' || binding !== null && current === null) };
}
