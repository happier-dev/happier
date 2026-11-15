import * as React from 'react';
import { useActiveServerAccountScopeLifetime, useIsSessionDraftsReady } from '@/sync/domains/state/storage';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { sync } from '@/sync/sync';
import { canonicalSessionDraftAddressV2, type SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import {
    areServerAccountScopesEqual,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
    type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import { prepareLocalSessionDraftScope } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { fireAndForget } from '@/utils/system/fireAndForget';

type SessionDraftHydrationAdmissionInput = Readonly<{
    /** Omit only when the consumer needs the complete draft collection. */
    addresses?: readonly Extract<SessionDraftAddressV2, { kind: 'session' | 'newSession' }>[];
    lifetime?: ServerAccountScopeLifetime | null;
    /** Exact local custody for a host that has no Account draft-read authority. */
    localScope?: ServerAccountScope | null;
}>;

/** Editable hosts take custody after their own scoped draft hydration attempt. */
export function SessionDraftHydrationBoundary(props: SessionDraftHydrationAdmissionInput & Readonly<{
    children: React.ReactNode;
    /** The host's existing surface shape while first admission is pending. */
    fallback?: React.ReactNode;
}>) {
    return useSessionDraftHydrationAdmission(props)
        ? <>{props.children}</>
        : props.fallback ?? <PaneLoadingFallback testID="session-drafts-hydrating" />;
}

/**
 * Whether an editable draft host may take custody: the complete collection is ready, or this
 * host's own exact addresses were hydrated (one read each). A host whose non-editable surface
 * does not depend on drafts (a Session's transcript and header) presents it at once and gates
 * only its editor on this admission.
 */
export function useSessionDraftHydrationAdmission(props: SessionDraftHydrationAdmissionInput): boolean {
    const collectionReady = useIsSessionDraftsReady();
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = props.lifetime === undefined ? activeLifetime : props.lifetime;
    const localScope = props.localScope ?? null;
    const localScopeKey = localScope ? serverAccountScopeKeySuffix(localScope) : null;
    const localScopeRef = React.useRef(localScope);
    localScopeRef.current = localScope;
    const ready = localScopeKey === null && collectionReady && (!lifetime || lifetime.isCurrent())
        && (props.lifetime == null || areServerAccountScopesEqual(lifetime?.scope, activeLifetime?.scope));
    const addressKey = props.addresses?.map(canonicalSessionDraftAddressV2).sort().join('\u0000') ?? null;
    const addresses = React.useRef(props.addresses);
    addresses.current = props.addresses;
    const [admitted, setAdmitted] = React.useState<Readonly<{
        lifetime: typeof lifetime;
        localScopeKey: string | null;
        addressKey: typeof addressKey;
    }> | null>(null);
    React.useEffect(() => {
        if (ready || addressKey === null) return;
        let mounted = true;
        const requestedAddresses = addresses.current ?? [];
        const requestedLocalScope = localScopeRef.current;
        if (requestedLocalScope && localScopeKey !== null) {
            fireAndForget(Promise.resolve().then(() => prepareLocalSessionDraftScope(requestedLocalScope)).then(() => {
                if (mounted) setAdmitted({ lifetime, localScopeKey, addressKey });
            }), { tag: 'SessionDraftHydrationBoundary.prepareLocal' });
            return () => { mounted = false; };
        }
        if (!lifetime?.isCurrent()) return;
        fireAndForget(Promise.resolve().then(() => sync.prepareSessionDraftSurface(lifetime, requestedAddresses)).then((hydrated) => {
            if (mounted && hydrated && lifetime.isCurrent()) setAdmitted({ lifetime, localScopeKey, addressKey });
        }), { tag: 'SessionDraftHydrationBoundary.prepare' });
        return () => { mounted = false; };
    }, [addressKey, lifetime, localScopeKey, ready]);
    const admittedScope = React.useRef<Readonly<{
        lifetime: typeof lifetime;
        localScopeKey: string | null;
        addressKey: typeof addressKey;
    }> | null>(null);
    React.useLayoutEffect(() => {
        if (ready || (admitted?.lifetime === lifetime && admitted?.localScopeKey === localScopeKey && admitted?.addressKey === addressKey)) {
            admittedScope.current = { lifetime, localScopeKey, addressKey };
        }
    }, [addressKey, admitted, lifetime, localScopeKey, ready]);
    // This is a first-hydration barrier, not custody revocation. A later pending
    // publication cannot unmount an admitted editor and erase its consumed seed
    // or edits. A changed canonical Account lifetime or explicit local scope retires admission.
    const retainsCustody = admittedScope.current?.lifetime === lifetime
        && admittedScope.current.localScopeKey === localScopeKey
        && admittedScope.current.addressKey === addressKey
        && (localScopeKey !== null || (lifetime !== null && lifetime.isCurrent()));
    const surfaceReady = admitted !== null && admitted.lifetime === lifetime
        && admitted.localScopeKey === localScopeKey && admitted.addressKey === addressKey
        && (localScopeKey !== null || lifetime?.isCurrent());
    return ready || surfaceReady || retainsCustody;
}
