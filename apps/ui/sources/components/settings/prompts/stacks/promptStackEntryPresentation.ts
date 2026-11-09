import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import * as React from 'react';

import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useArtifactRows } from '@/sync/domains/state/storage';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { memoryDocumentHref } from '@/components/memory/memoryDocumentRoutes';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionRoutes';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { promptStackArtifactPresentation, UNKNOWN_PROMPT_STACK_PRESENTATION as UNKNOWN, type PromptStackEntryPresentation } from './promptStackDocumentChoices';
export { promptStackArtifactPresentation, type PromptStackEntryPresentation } from './promptStackDocumentChoices';
export type PromptStackEntryPresentationStatus = 'loading' | 'ready' | 'unavailable';
export type PromptStackEntryPresentations = ((entry: PromptStackEntryV1) => PromptStackEntryPresentation) & Readonly<{
    status: (entry: PromptStackEntryV1) => PromptStackEntryPresentationStatus;
}>;

function presentationIsAvailable(entry: PromptStackEntryV1, value: PromptStackEntryPresentation): boolean {
    return value.kind !== 'unknown' && (entry.ref.kind === 'bundle') === (value.kind === 'skill');
}

/** Display facts belong to the admitted Home/Account lifetime, never to a bare Artifact id. */
export function usePromptStackEntryPresentations(entries: readonly PromptStackEntryV1[], serverId: string): PromptStackEntryPresentations {
    const activeScope = useActiveServerAccountScope(serverId);
    const [refresh, reload] = React.useReducer((value: number) => value + 1, 0);
    const lifetime = useActiveServerAccountScopeLifetime();
    const home = (entry: PromptStackEntryV1) => {
        const target = resolveServerProfileScopeIdForIdentifier(entry.ref.serverId?.trim() || serverId);
        return activeScope && areServerProfileIdentifiersEquivalent(target, activeScope.serverId) ? activeScope.serverId : target;
    };
    const artifacts = useArtifactRows(entries.filter(entry => home(entry) === activeScope?.serverId).map(entry => entry.ref.artifactId));
    const activeHeaders = React.useMemo(() => new Map(artifacts.flatMap(artifact => !artifact || artifact.draft ? [] : [[artifact.id,
        artifact.isDecrypted === false ? UNKNOWN : promptStackArtifactPresentation(artifact.header, artifact.access)] as const])), [artifacts]);
    const requested = new Map<string, PromptStackEntryV1['ref']>();
    for (const entry of entries) {
        const target = home(entry);
        if (target === activeScope?.serverId && activeHeaders.has(entry.ref.artifactId)) continue;
        requested.set(JSON.stringify([target, entry.ref.artifactId]), { ...entry.ref, serverId: target });
    }
    const requestKey = JSON.stringify([...requested.values()]);
    const refs = React.useMemo(() => [...requested.values()], [requestKey]);
    const bindings = useServerCredentialAccountScopeBindings(refs.map(ref => ref.serverId));
    const scopeKey = JSON.stringify([activeScope?.serverId, activeScope?.accountId, serverId]);
    type Fact = Readonly<{
        value: PromptStackEntryPresentation;
        status: Exclude<PromptStackEntryPresentationStatus, 'loading'>;
        retainExisting: boolean;
        isCurrent: () => boolean;
    }>;
    type Read = Readonly<{ key: string; facts: ReadonlyMap<string, Fact> }>;
    const [read, setRead] = React.useState<Read | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        const accounts: LazyActionAccountContext[] = [];
        const retirements: Readonly<{ dispose(): void }>[] = [];
        const refreshers = new Map<string, () => void>();
        const requests = new Set<AbortController>();
        const byHome = new Map<string, PromptStackEntryV1['ref'][]>();
        for (const ref of refs) {
            const target = ref.serverId ?? serverId;
            byHome.set(target, [...(byHome.get(target) ?? []), ref]);
        }
        setRead(previous => {
            if (!previous || previous.key !== scopeKey) return null;
            const facts = new Map([...previous.facts].filter(([key]) => requested.has(key)));
            return facts.size === previous.facts.size ? previous : { key: scopeKey, facts };
        });
        const unsubscribeChanges = subscribeHomeAccountChange(event => {
            // Consume the producer's exact decision; coarse/unknown wakes still refresh access facts.
            if (event.profileCatalogAffects === false) return;
            // A precise Artifact wake can exclude unrelated ids even when its
            // broader Profile/catalog decision is true. Coarse recovery wakes
            // still refresh the requested headers through the same reader.
            if (event.changeKinds?.every(kind => kind === 'artifact')) {
                if (event.entityIds && !refs.some(ref => areServerProfileIdentifiersEquivalent(event.serverId, ref.serverId ?? serverId)
                    && event.entityIds!.includes(ref.artifactId))) return;
            }
            for (const [target, refresh] of refreshers)
                if (areServerProfileIdentifiersEquivalent(event.serverId, target)) refresh();
        }, { serverIds: [...byHome.keys()], reconnect: 'refresh' });
        if (lifetime) retirements.push(lifetime.onRetire(reload));
        void Promise.all([...byHome].map(async ([target, group]) => {
            try {
                const binding = bindings.get(target);
                if (!binding?.isCurrent()) return;
                const [{ captureLazyActionAccountContext }, { withUiPromptLibraryArtifactReader }] = await Promise.all([
                    import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/promptLibrary/promptLibraryArtifactStore'),
                ]);
                const account = await captureLazyActionAccountContext(target, controller.signal);
                if (controller.signal.aborted) { account.dispose(); return; }
                accounts.push(account);
                if (!binding.isCurrent() || binding.accountId !== account.accountId) return;
                retirements.push(account.accountLifetime.onRetire(reload));
                let pending: AbortController | null = null;
                const refreshHeaders = async () => {
                    pending?.abort();
                    const request = new AbortController();
                    pending = request;
                    requests.add(request);
                    try {
                        const facts = await withUiPromptLibraryArtifactReader(reader => Promise.all(group.map(async ref => {
                            let value = UNKNOWN;
                            let status: Fact['status'] = 'ready';
                            let retainExisting = false;
                            try {
                                const artifact = await reader.readArtifactHeader(ref);
                                value = promptStackArtifactPresentation(artifact?.header, artifact?.access);
                            } catch (error) {
                                // A retryable transport failure establishes no
                                // revocation. Keep an admitted retained fact, but
                                // publish the failed coverage when no fact exists.
                                status = 'unavailable';
                                retainExisting = error instanceof HappyError && error.canTryAgain;
                            }
                            if (value.kind === 'unknown') status = 'unavailable';
                            return [JSON.stringify([target, ref.artifactId]), { value, status, retainExisting,
                                isCurrent: binding.isCurrent }] as const;
                        })), { serverId: target, signal: request.signal, accountContext: account });
                        account.assertCurrent();
                        if (!request.signal.aborted && !controller.signal.aborted && binding.isCurrent() && (!lifetime || lifetime.isCurrent()))
                            setRead(previous => {
                                const baseline = previous?.key === scopeKey ? previous.facts : new Map<string, Fact>();
                                let next: Map<string, Fact> | undefined;
                                for (const fact of facts) {
                                    if (!fact) continue;
                                    const [key, incoming] = fact;
                                    const old = baseline.get(key);
                                    if (incoming.retainExisting && old && old.value.kind !== 'unknown') continue;
                                    if (old?.isCurrent === incoming.isCurrent && old.value.kind === incoming.value.kind
                                        && old.value.title === incoming.value.title && old.value.headerKind === incoming.value.headerKind
                                        && old.value.access === incoming.value.access && old.status === incoming.status) continue;
                                    if (!next) next = new Map(baseline);
                                    next.set(key, incoming);
                                }
                                return !next && previous?.key === scopeKey ? previous : { key: scopeKey, facts: next ?? baseline };
                            });
                    } catch {
                        // A batch-level transport failure settles coverage for
                        // new refs, but cannot replace an admitted retained fact.
                        if (!request.signal.aborted && !controller.signal.aborted && binding.isCurrent()
                            && (!lifetime || lifetime.isCurrent()))
                            setRead(previous => {
                                const baseline = previous?.key === scopeKey ? previous.facts : new Map<string, Fact>();
                                let next: Map<string, Fact> | undefined;
                                for (const ref of group) {
                                    const key = JSON.stringify([target, ref.artifactId]);
                                    const old = baseline.get(key);
                                    if (old && old.value.kind !== 'unknown') continue;
                                    if (old?.status === 'unavailable' && old.isCurrent === binding.isCurrent) continue;
                                    if (!next) next = new Map(baseline);
                                    next.set(key, { value: UNKNOWN, status: 'unavailable', retainExisting: true,
                                        isCurrent: binding.isCurrent });
                                }
                                return !next && previous?.key === scopeKey ? previous : { key: scopeKey, facts: next ?? baseline };
                            });
                    }
                    finally { requests.delete(request); }
                };
                refreshers.set(target, () => { void refreshHeaders(); });
                await refreshHeaders();
            } catch { /* Missing, locked, unavailable or retired headers remain explicitly unknown. */ }
        }));
        return () => {
            unsubscribeChanges(); for (const retirement of retirements) retirement.dispose();
            controller.abort(); for (const request of requests) request.abort();
            for (const account of accounts) account.dispose();
        };
    }, [refs, bindings, scopeKey, serverId, lifetime, refresh]);
    const presentation = React.useCallback((entry: PromptStackEntryV1) => {
        if (lifetime && !lifetime.isCurrent()) return UNKNOWN;
        const target = home(entry);
        const active = activeScope && areServerProfileIdentifiersEquivalent(target, activeScope.serverId);
        const local = active && lifetime?.isCurrent() ? activeHeaders.get(entry.ref.artifactId) : undefined;
        const key = JSON.stringify([active ? activeScope.serverId : target, entry.ref.artifactId]);
        const remote = requested.has(key) && read?.key === scopeKey ? read.facts.get(key) : undefined;
        const value = local ?? (remote?.isCurrent() ? remote.value : UNKNOWN);
        return (entry.ref.kind === 'bundle') === (value.kind === 'skill') ? value : UNKNOWN;
    }, [activeHeaders, activeScope, lifetime, read, scopeKey, serverId, requestKey]);
    const status = React.useCallback((entry: PromptStackEntryV1): PromptStackEntryPresentationStatus => {
        if (lifetime && !lifetime.isCurrent()) return 'unavailable';
        const target = home(entry);
        const active = activeScope && areServerProfileIdentifiersEquivalent(target, activeScope.serverId);
        const local = active && lifetime?.isCurrent() ? activeHeaders.get(entry.ref.artifactId) : undefined;
        if (local) return presentationIsAvailable(entry, local) ? 'ready' : 'unavailable';
        const key = JSON.stringify([active ? activeScope.serverId : target, entry.ref.artifactId]);
        if (!requested.has(key)) return 'ready';
        const remote = read?.key === scopeKey ? read.facts.get(key) : undefined;
        if (!remote?.isCurrent()) return 'loading';
        return remote.status === 'ready' && presentationIsAvailable(entry, remote.value) ? 'ready' : 'unavailable';
    }, [activeHeaders, activeScope, lifetime, read, scopeKey, serverId, requestKey]);
    return React.useMemo(() => Object.assign(presentation, { status }), [presentation, status]);
}

/** Where an entry's text goes, in the words every Context list uses. */
export function promptStackPlacementLabel(placement: PromptStackEntryV1['placement']): string {
    return placement === 'skill_instructions' ? t('promptLibrary.stackPlacementSkill')
        : placement === 'composer_insert' ? t('promptLibrary.stackPlacementComposer') : t('promptLibrary.stackPlacementSystem');
}

export function promptStackEntryTitle(entry: PromptStackEntryV1, presentations: PromptStackEntryPresentations): string {
    return presentations(entry).title || t('promptLibrary.untitledPrompt');
}

/** A context entry is memory when its document is a `memory_doc.v1` Artifact (never by entry id). */
export function isMemoryStackEntry(entry: PromptStackEntryV1, presentations: PromptStackEntryPresentations): boolean {
    return presentations(entry).kind === 'memory';
}

/** The library editor of an entry's document. */
export function promptStackEntryHref(entry: PromptStackEntryV1, kind: PromptStackEntryPresentation['kind'], serverId: string): string | null {
    if (kind === 'unknown') return null;
    const target = entry.ref.serverId?.trim() || serverId;
    return kind === 'memory' ? memoryDocumentHref(entry.ref, { serverId: target })
        : promptCollectionItemHref(kind === 'skill' ? 'bundle' : 'doc', entry.ref.artifactId, { serverId: target });
}

/**
 * "How much to load" is offered in words and stored as the entry's `maxChars`. Six characters a word
 * (five letters and the space after them, the usual English average); nothing else in the product
 * converts words to characters, so this is the one place the ratio lives.
 */
export { CONTEXT_LOAD_CHARS_PER_WORD, CONTEXT_LOAD_WORD_OPTIONS } from './promptStackBudgetChoices';
