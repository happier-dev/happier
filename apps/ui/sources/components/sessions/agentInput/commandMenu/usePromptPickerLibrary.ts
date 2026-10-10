import * as React from 'react';
import { readPromptDocInLibrary, setPromptDocFavorite, type PromptLibraryListItem } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { PromptInvocationEntryV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import type { PromptFoldersV1 } from '@happier-dev/protocol';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { readPromptLibraryCatalogProjectionInContext } from '@/sync/api/account/apiPromptLibraryCatalog';

type Inventory = Readonly<{
    serverId: string | null;
    documents: readonly PromptLibraryListItem[];
    invocations: readonly PromptInvocationEntryV1[];
    folders: readonly PromptFoldersV1['folders'][number][];
    coverage: 'complete' | 'partial' | 'unavailable';
}>;
const EMPTY: Inventory = { serverId: null, documents: [], invocations: [], folders: [], coverage: 'unavailable' };

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
            const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
            const [library, projection] = await Promise.all([
                executeDefaultActionInCapturedAccount(captured, 'prompts.library.list', { includeBundles: false }, {
                    surface: 'ui', authority: 'present_user', serverId, expectedAccountId: captured.accountId, signal: controller.signal,
                }).then((result) => {
                    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                    return result.result as PublicActionResultById['prompts.library.list'];
                }),
                readPromptLibraryCatalogProjectionInContext(captured, controller.signal),
            ]);
            captured.assertCurrent();
            const invocations = readPromptLibraryCatalogRecordV1({ ...projection, key: 'invocations' });
            const folders = readPromptLibraryCatalogRecordV1({ ...projection, key: 'folders' });
            if (invocations.status !== 'ready' || invocations.record.key !== 'invocations'
                || folders.status !== 'ready' || folders.record.key !== 'folders') throw new Error('prompt_picker_catalog_unavailable');
            if (resource.current === current && !controller.signal.aborted) {
                setInventory({ serverId, documents: library.items, invocations: invocations.record.value.entries,
                    folders: folders.record.value.folders, coverage: library.coverage });
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

    const read = React.useCallback((artifactId: string, targetServerId?: string | null): Promise<string> => {
        const current = resource.current;
        if (!current || current.signal.aborted) return Promise.reject(new Error('prompt_picker_closed'));
        const ref = { kind: 'doc' as const, artifactId, ...(targetServerId ? { serverId: targetServerId } : {}) };
        const key = JSON.stringify([ref.serverId ?? null, artifactId]);
        const existing = current.reads.get(key);
        if (existing) return existing;
        const pending = current.account.then(async (account) => {
            account.assertCurrent();
            const result = await withUiPromptLibraryArtifactReader((reader) => readPromptDocInLibrary({
                store: { ...createUiPromptLibraryArtifactStore(account.workflowArtifacts), read: () => reader.readArtifact(ref) },
                artifactId, signal: current.signal,
            }), { accountContext: account, signal: current.signal });
            account.assertCurrent();
            if (!result.ok) throw new Error(result.errorCode);
            return result.markdown;
        });
        current.reads.set(key, pending);
        void pending.finally(() => {
            if (current.reads.get(key) === pending) current.reads.delete(key);
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
