import * as React from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ScmDiffSummaryWalkthrough } from '@happier-dev/protocol/scm';
import { AppPaneContext, type AppPaneContextSubscription } from '@/components/appShell/panes/AppPaneContext';

export type WalkthroughDraft = Readonly<{
    expectedRevision: number;
    base: ScmDiffSummaryWalkthrough;
    title: string;
    stopId?: string;
    stopTitle: string;
    prose: string;
}>;

const createDraftStore = () => createStore<Readonly<Record<string, WalkthroughDraft>>>(() => ({}));
// A draft is authoritative local input, not a projection of the published result. Its lifetime is the
// existing pane provider's, so replacing the reading cannot discard it. It never enters pane persistence.
const paneDrafts = new WeakMap<AppPaneContextSubscription, ReturnType<typeof createDraftStore>>();

/** The retained review pane owns the draft across presentation remounts, never a result revision. */
export function useWalkthroughDraft(key: string | null, scopeId?: string) {
    const pane = React.useContext(AppPaneContext);
    const [local] = React.useState(createDraftStore);
    let owner = local;
    if (pane && scopeId) {
        const retained = paneDrafts.get(pane) ?? createDraftStore();
        paneDrafts.set(pane, retained);
        owner = retained;
    }
    const draftKey = JSON.stringify([scopeId, key]);
    const draft = useStore(owner, state => key ? state[draftKey] ?? null : null);
    const setDraft = React.useCallback((update: React.SetStateAction<WalkthroughDraft | null>) => {
        if (!key) return;
        owner.setState(current => {
            const previous = current[draftKey] ?? null;
            const draft = typeof update === 'function' ? update(previous) : update;
            if (draft === previous) return current;
            const next = { ...current };
            if (draft) next[draftKey] = draft;
            else delete next[draftKey];
            return next;
        }, true);
    }, [draftKey, key, owner]);
    return [draft, setDraft] as const;
}
