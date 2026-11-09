import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionIdSchema} from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createAppShellAction } from '@/sync/ops/actions/appShellAction';
import { useNewSessionMachinePathState } from './useNewSessionMachinePathState';
import { useNewSessionComposerDocument } from './useNewSessionComposerDocument';
import { createNewSessionPromptStore } from './newSessionPromptStore';

afterEach(() => standardCleanup());

describe('Contextual New Session directory Action', () => {
    it.each([
        ['Home', 'server-b', 'account-a'],
        ['Account', 'server-a', 'account-b'],
    ] as const)('refuses another %s even when it knows the current mounted draft ref', async (_scope, serverId, runtimeAccountId) => {
        const actionId = ActionIdSchema.parse('session.draft.directory.set');
        const promptStore = createNewSessionPromptStore('Exact Home draft');
        const hook = await renderHook(() => {
            const paths = useNewSessionMachinePathState({ serverId: 'server-a', machines: [],
                recentMachinePaths: [], machineIdParam: null, pathParam: '/repo' });
            const document = useNewSessionComposerDocument({ draftId: 'home-scoped-directory', promptStore,
                draftScope: { serverId: 'server-a', accountId: 'account-a' }, persistedAttachments: [],
                composerAttachmentEntriesById: {}, scopeKey: 'server-a/account-a', canSubmitRef: { current: true },
                isSubmitting: false, setDirectoryIntent: paths.setDirectoryIntent });
            return { paths, document };
        });
        const executor = createActionExecutor({ appShellAction: createAppShellAction() } as Parameters<typeof createActionExecutor>[0]);
        expect(await executor.execute(actionId, { ref: hook.getCurrent().document.ref,
            directory: { kind: 'managed' } }, { surface: 'mcp', serverId, runtimeAccountId }))
            .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(hook.getCurrent().paths.directoryIntent).toEqual({ kind: 'path', path: '/repo' });
        await hook.unmount();
    });

    it('changes only the exact mounted editable draft through its existing directory owner', async () => {
        const actionId = ActionIdSchema.parse('session.draft.directory.set');
        const promptStore = createNewSessionPromptStore('Keep this prompt');
        const hook = await renderHook((props: { submitting: boolean }) => {
            const paths = useNewSessionMachinePathState({ serverId: 'server-a', machines: [],
                recentMachinePaths: [], machineIdParam: null, pathParam: '/repo' });
            const params = { draftId: 'directory-action', promptStore, persistedAttachments: [],
                composerAttachmentEntriesById: {}, scopeKey: null, canSubmitRef: { current: true },
                isSubmitting: props.submitting,
                setDirectoryIntent: paths.directoryIntentFixed ? undefined : paths.setDirectoryIntent };
            const document = useNewSessionComposerDocument(params);
            return { paths, document };
        }, { initialProps: { submitting: false } });
        // No transport dependency is used by this client-placed Action. The
        // mounted directory/document owners and canonical executor are real.
        const executor = createActionExecutor({ appShellAction: createAppShellAction() } as Parameters<typeof createActionExecutor>[0]);
        const ref = hook.getCurrent().document.ref;
        let result: unknown;
        await act(async () => { result = await executor.execute(actionId,
            { ref, directory: { kind: 'managed' } }, { surface: 'mcp', authority: 'account_automation' }); });
        expect(result).toMatchObject({ ok: true, result: { status: 'applied' } });
        expect(hook.getCurrent().paths.directoryIntent).toEqual({ kind: 'managed' });
        expect(promptStore.getPrompt()).toBe('Keep this prompt');
        expect(await executor.execute(actionId, { ref: { ...ref, instanceId: 'another-draft' },
            directory: { kind: 'path', path: '/wrong' } }, { surface: 'agent' }))
            .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        await hook.rerender({ submitting: true });
        expect(await executor.execute(actionId, { ref, directory: { kind: 'path', path: '/locked' } }, { surface: 'agent' }))
            .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        await hook.unmount();
        expect(await executor.execute(actionId, { ref, directory: { kind: 'path', path: '/retired' } }, { surface: 'agent' }))
            .toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });
});
