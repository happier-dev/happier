import type { PromptStackEntryV1 } from '@happier-dev/protocol';
import * as React from 'react';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope, useArtifacts } from '@/sync/domains/state/storage';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { memoryDocumentHref } from '@/components/memory/memoryDocumentRoutes';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionRoutes';
import { t } from '@/text';

import { promptStackArtifactPresentation, UNKNOWN_PROMPT_STACK_PRESENTATION as UNKNOWN, type PromptStackEntryPresentation } from './promptStackDocumentChoices';
export { promptStackArtifactPresentation, type PromptStackEntryPresentation } from './promptStackDocumentChoices';
export type PromptStackEntryPresentations = (entry: PromptStackEntryV1) => PromptStackEntryPresentation;

/** Display facts belong to the admitted Home/Account lifetime, never to a bare Artifact id. */
export function usePromptStackEntryPresentations(entries: readonly PromptStackEntryV1[], serverId: string): PromptStackEntryPresentations {
    const activeScope = useActiveServerAccountScope(serverId);
    const artifacts = useArtifacts();
    const [refresh, reload] = React.useReducer((value: number) => value + 1, 0);
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [activeScope?.serverId, activeScope?.accountId, refresh]);
    const home = (entry: PromptStackEntryV1) => {
        const target = entry.ref.serverId?.trim() || serverId;
        return activeScope && areServerProfileIdentifiersEquivalent(target, activeScope.serverId) ? activeScope.serverId : target;
    };
    const activeHeaders = React.useMemo(() => new Map(artifacts.map(artifact => [artifact.id,
        artifact.isDecrypted === false ? UNKNOWN : promptStackArtifactPresentation(artifact.header, artifact.access)])), [artifacts]);
    const requested = new Map<string, PromptStackEntryV1['ref']>();
    for (const entry of entries) {
        const target = home(entry);
        if (target === activeScope?.serverId && activeHeaders.has(entry.ref.artifactId)) continue;
        requested.set(JSON.stringify([target, entry.ref.artifactId]), { ...entry.ref, serverId: target });
    }
    const requestKey = JSON.stringify([...requested.values()]);
    const refs = React.useMemo(() => [...requested.values()], [requestKey]);
    const scopeKey = JSON.stringify([activeScope?.serverId, activeScope?.accountId, serverId, requestKey, refresh]);
    type Read = Readonly<{ key: string; facts: ReadonlyMap<string, Readonly<{ value: PromptStackEntryPresentation; isCurrent: () => boolean }>> }>;
    const [read, setRead] = React.useState<Read | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        const accounts: LazyActionAccountContext[] = [];
        const retirements: Readonly<{ dispose(): void }>[] = [];
        const byHome = new Map<string, PromptStackEntryV1['ref'][]>();
        for (const ref of refs) {
            const target = ref.serverId ?? serverId;
            byHome.set(target, [...(byHome.get(target) ?? []), ref]);
        }
        const unsubscribeChanges = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                || [...byHome.keys()].some(target => areServerProfileIdentifiersEquivalent(event.serverId, target))) reload();
        });
        if (lifetime) retirements.push(lifetime.onRetire(reload));
        void Promise.all([...byHome].map(async ([target, group]) => {
            try {
                const [{ captureLazyActionAccountContext }, { withUiPromptLibraryArtifactReader }] = await Promise.all([
                    import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/promptLibrary/promptLibraryArtifactStore'),
                ]);
                const account = await captureLazyActionAccountContext(target, controller.signal);
                if (controller.signal.aborted) { account.dispose(); return; }
                accounts.push(account);
                retirements.push(account.accountLifetime.onRetire(reload));
                const facts = await withUiPromptLibraryArtifactReader(reader => Promise.all(group.map(async ref => {
                    let value = UNKNOWN;
                    try { value = promptStackArtifactPresentation((await reader.readArtifactHeader(ref))?.header); } catch { /* This entry is unavailable; admitted neighbors stay visible. */ }
                    return [JSON.stringify([target, ref.artifactId]), { value,
                        isCurrent: account.accountLifetime.isCurrent }] as const;
                })), { serverId: target, signal: controller.signal, accountContext: account });
                account.assertCurrent();
                if (!controller.signal.aborted && (!lifetime || lifetime.isCurrent())) setRead(previous => ({ key: scopeKey,
                    facts: new Map([...(previous?.key === scopeKey ? previous.facts : []), ...facts]) }));
            } catch { /* Missing, locked, unavailable or retired headers remain explicitly unknown. */ }
        }));
        return () => { unsubscribeChanges(); for (const retirement of retirements) retirement.dispose(); controller.abort(); for (const account of accounts) account.dispose(); };
    }, [refs, scopeKey, serverId, lifetime]);
    return React.useCallback(entry => {
        if (lifetime && !lifetime.isCurrent()) return UNKNOWN;
        const target = entry.ref.serverId?.trim() || serverId;
        const active = activeScope && areServerProfileIdentifiersEquivalent(target, activeScope.serverId);
        const local = active && lifetime?.isCurrent() ? activeHeaders.get(entry.ref.artifactId) : undefined;
        const remote = read?.key === scopeKey ? read.facts.get(JSON.stringify([active ? activeScope.serverId : target, entry.ref.artifactId])) : undefined;
        const value = local ?? (remote?.isCurrent() ? remote.value : UNKNOWN);
        return (entry.ref.kind === 'bundle') === (value.kind === 'skill') ? value : UNKNOWN;
    }, [activeHeaders, activeScope, lifetime, read, scopeKey, serverId]);
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
