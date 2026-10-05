import * as React from 'react';
import { listPromptLibrary, readPromptDocInLibrary, setPromptDocFavorite, type PromptInvocationEntryV1, type PromptLibraryListItem } from '@happier-dev/protocol';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';

type Inventory = Readonly<{
    serverId: string | null;
    documents: readonly PromptLibraryListItem[];
    invocations: readonly PromptInvocationEntryV1[];
    coverage: 'complete' | 'partial' | 'unavailable';
}>;
const EMPTY: Inventory = { serverId: null, documents: [], invocations: [], coverage: 'unavailable' };

/** Mounted only while the picker is open; all work shares this exact Account lifetime. */
export function usePromptPickerLibrary(serverId: string) {
    const [inventory, setInventory] = React.useState<Inventory>(EMPTY);
    const [isLoading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);
    const [refresh, setRefresh] = React.useState(0);
    const resource = React.useRef<Readonly<{
        account: Promise<LazyActionAccountContext>;
        signal: AbortSignal;
        reads: Map<string, Promise<string>>;
    }> | null>(null);

    React.useEffect(() => {
        const controller = new AbortController();
        const account = captureLazyActionAccountContext(serverId, controller.signal);
        const current = { account, signal: controller.signal, reads: new Map<string, Promise<string>>() };
        let retireSubscription: Readonly<{ dispose: () => void }> | undefined;
        resource.current = current;
        setLoading(true);
        setError(false);
        void account.then(async (captured) => {
            if (controller.signal.aborted || resource.current !== current) return;
            retireSubscription = captured.accountLifetime.onRetire(() => {
                if (resource.current !== current) return;
                setInventory(EMPTY);
                setError(true);
                setLoading(false);
                controller.abort();
            });
            const store = createUiPromptLibraryArtifactStore(captured.workflowArtifacts);
            const [library, settings] = await Promise.all([
                listPromptLibrary({ store, request: { includeBundles: false }, signal: controller.signal }),
                captured.readSettings(),
            ]);
            captured.assertCurrent();
            if (resource.current === current && !controller.signal.aborted) {
                setInventory({ serverId, documents: library.items, invocations: settings.promptInvocationsV1.entries, coverage: library.coverage });
            }
        }).catch(() => {
            if (!controller.signal.aborted && resource.current === current) setError(true);
        }).finally(() => {
            if (!controller.signal.aborted && resource.current === current) setLoading(false);
        });
        return () => {
            retireSubscription?.dispose();
            controller.abort();
            if (resource.current === current) resource.current = null;
            void account.then((captured) => captured.dispose(), () => {});
        };
    }, [serverId, refresh]);

    const read = React.useCallback((artifactId: string): Promise<string> => {
        const current = resource.current;
        if (!current || current.signal.aborted) return Promise.reject(new Error('prompt_picker_closed'));
        const existing = current.reads.get(artifactId);
        if (existing) return existing;
        const pending = current.account.then(async (account) => {
            account.assertCurrent();
            const result = await readPromptDocInLibrary({ store: createUiPromptLibraryArtifactStore(account.workflowArtifacts), artifactId, signal: current.signal });
            account.assertCurrent();
            if (!result.ok) throw new Error(result.errorCode);
            return result.markdown;
        });
        current.reads.set(artifactId, pending);
        void pending.finally(() => {
            if (current.reads.get(artifactId) === pending) current.reads.delete(artifactId);
        }).catch(() => {});
        return pending;
    }, []);

    const setFavorite = React.useCallback(async (artifactId: string, favorite: boolean) => {
        const current = resource.current;
        if (!current || current.signal.aborted) throw new Error('prompt_picker_closed');
        const account = await current.account;
        account.assertCurrent();
        await setPromptDocFavorite({ store: createUiPromptLibraryArtifactStore(account.workflowArtifacts), request: { artifactId, favorite }, signal: current.signal });
        account.assertCurrent();
        if (resource.current === current) {
            setInventory((previous) => ({ ...previous, documents: previous.documents.map((doc) => doc.artifactId === artifactId ? { ...doc, favorite } : doc) }));
        }
    }, []);

    // A prompt this picker just created (Save in place) joins the listing at once; the next open re-lists.
    const adopt = React.useCallback((item: PromptLibraryListItem) => {
        setInventory((previous) => previous.serverId !== serverId ? previous
            : { ...previous, documents: [item, ...previous.documents.filter((doc) => doc.artifactId !== item.artifactId)] });
    }, [serverId]);

    return { ...(inventory.serverId === serverId ? inventory : EMPTY), isLoading, error, read, setFavorite, adopt, retry: () => setRefresh((value) => value + 1) };
}
