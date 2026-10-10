import { afterEach, describe, expect, it } from 'vitest';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptInvocationsV1Schema } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import { PromptFoldersV1Schema } from '@happier-dev/protocol';
import { renderHook } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { usePromptPickerLibrary } from './usePromptPickerLibrary';
import { storage } from '@/sync/domains/state/storage';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

describe('prompt picker Account invocation inventory', () => {
    let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
    let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof usePromptPickerLibrary>>>> | undefined;
    afterEach(async () => { await hook?.unmount(); fixture?.dispose(); });

    it('does not resurrect retained Settings invocations or folders over current empty destinations', async () => {
        const retained = { v: 1, entries: [{ id: 'stale', token: '/stale', title: 'Stale',
            target: { kind: 'doc', artifactId: 'stale-doc' }, behavior: 'insert', allowArgs: false, availableIn: 'global' }] };
        const retainedFolders = { v: 1, folders: [{ id: 'stale-folder', name: 'Stale folder' }] };
        const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        fixture = await createPlainArtifactHomeFixture('https://prompt-picker.example', {
            handleRequest: async (path) => path === '/v2/account/settings'
                ? response({ content: { t: 'plain', v: { promptInvocationsV1: retained, promptFoldersV1: retainedFolders } }, version: 3 })
                : path === PROMPT_LIBRARY_ROWS_ROUTE_V1
                    ? response({ status: 'listed', rows: [{ key: 'invocations', revision: 7,
                        content: { t: 'plain', v: { key: 'invocations', value: { v: 1, entries: [] } } } },
                        ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'invocations').map(key => ({ key, revision: 1, content: null }))] })
                    : null,
        });
        // The captured Settings path reads this real admitted store before HTTP.
        // A stale HTTP-only baseline would let that competing path pass too.
        storage.setState({ settings: { ...storage.getState().settings,
            promptInvocationsV1: PromptInvocationsV1Schema.parse(retained), promptFoldersV1: PromptFoldersV1Schema.parse(retainedFolders) } });
        hook = await renderHook(() => usePromptPickerLibrary(fixture!.home.id), { flushOptions: { cycles: 30, turns: 10 } });
        expect(hook.getCurrent()).toMatchObject({ isLoading: false, error: false, coverage: 'complete', invocations: [], folders: [] });
    });

    it('lists through prompts.library.list admission instead of reading the Artifact store directly', async () => {
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'prompts.library.list': { disabledSurfaces: ['ui'] } } });
        const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        fixture = await createPlainArtifactHomeFixture('https://prompt-picker-action.example', {
            handleRequest: async (path) => path === '/v2/account/settings'
                ? response({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 })
                : path === PROMPT_LIBRARY_ROWS_ROUTE_V1
                    ? response({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: null })) })
                    : null,
        });
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
        hook = await renderHook(() => usePromptPickerLibrary(fixture!.home.id), { flushOptions: { cycles: 30, turns: 10 } });
        expect(hook.getCurrent()).toMatchObject({ isLoading: false, error: true, documents: [] });
    });
});
