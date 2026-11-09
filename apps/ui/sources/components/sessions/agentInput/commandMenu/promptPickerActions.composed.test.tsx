import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/components/ui/popover', async original =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await import('@/sync/syncEngine');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
const { registerComposerPresentationTarget, registerSessionComposerPresentationTarget } =
    await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { AgentInputPromptPicker } = await import('./AgentInputPromptPicker');
const { usePromptPickerController } = await import('./usePromptPickerController');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(homes); });
afterEach(async () => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    await connection?.dispose(); connection = undefined;
});

async function seed() {
    const serverId = await homes.addHome({ name: 'Picker Actions', serverUrl: 'https://picker-actions.test', accountId: 'picker-account' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 2 }) });
    const catalog = createPromptLibraryCatalogBoundary();
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: async () => ({ body: await (await catalog.handle(PROMPT_LIBRARY_ROWS_ROUTE_V1))!.json() }) });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://picker-actions.test', accountId: 'picker-account', request: homes.request });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const created = await createPromptDocInLibrary({ store: createUiPromptLibraryArtifactStore(account.workflowArtifacts, account),
            request: { title: 'Review', markdown: 'Review $ARGUMENTS please', favorite: false } });
        homes.answer(serverId, '/v1/artifacts?limit=500', { body: homes.artifacts(serverId).list() });
        return { serverId, artifactId: created.artifactId };
    } finally { account.dispose(); }
}

function mountedInput() {
    const stateRef = { current: { text: 'before selected after', selection: { start: 7, end: 15 } } };
    const sent: string[] = [];
    // The imperative native TextInput and host submission are the UI/OS boundaries.
    const inputRef = { current: {
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => { stateRef.current = { text, selection }; },
        setSelection: (selection: { start: number; end: number }) => { stateRef.current = { ...stateRef.current, selection }; },
        focus: () => {},
    } };
    return { stateRef, inputRef, sent, send: () => { sent.push(stateRef.current.text); } };
}

function MountedPicker({ serverId, composerRef, input }: Readonly<{ serverId: string; composerRef: ComposerRefV1; input: ReturnType<typeof mountedInput> }>) {
    const controller = usePromptPickerController({ ...input, composerKey: JSON.stringify(composerRef), editable: true, canSend: true });
    React.useEffect(() => {
        const target = {
            readRevision: () => 1,
            replace: () => { throw new Error('Picker must use its mounted controller'); },
            readScope: () => ({ serverId, accountId: 'picker-account' }),
            readSnapshot: () => ComposerSnapshotV1Schema.parse({ revision: 1, ref: composerRef, text: input.stateRef.current.text,
                selection: input.stateRef.current.selection, references: [], attachments: [], layout: 'wrap',
                capabilities: { text: true, references: false, attachments: false, submit: true },
                state: { focused: true, editable: true, submittable: true, submitting: false, running: false } }),
            openPromptPicker: controller.open,
            readPromptPicker: () => controller.actionPortRef.current,
        };
        return composerRef.kind === 'session'
            ? registerSessionComposerPresentationTarget({ serverId, sessionId: composerRef.sessionId }, target)
            : registerComposerPresentationTarget(composerRef, target);
    }, [serverId, composerRef, input, controller.open, controller.actionPortRef]);
    return <KeyboardShortcutProvider handlers={{}}>{controller.isOpen ? <AgentInputPromptPicker
        anchor={{ kind: 'view', ref: { current: null } }} serverId={serverId}
        sessionId={composerRef.kind === 'session' ? composerRef.sessionId : null} canSend
        composerRef={composerRef}
        onApply={controller.apply} onRequestClose={controller.close} onActionPortChange={controller.setActionPort}
    /> : null}</KeyboardShortcutProvider>;
}

describe('Agent/MCP picker Actions at the real mounted controller', () => {
    it('inserts a human selection directly while disabled agent apply still refuses', async () => {
        const { serverId, artifactId } = await seed();
        const ref = { kind: 'newSession', instanceId: 'ui-policy-composer' } as const;
        const input = mountedInput();
        const screen = await renderScreen(<MountedPicker serverId={serverId} composerRef={ref} input={input} />);
        const executor = createDefaultActionExecutor();
        await act(async () => { await executor.execute('ui.prompts.picker.open', { composerRef: ref }, {
            surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'picker-account',
        }); });
        await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('prompt-picker-search')).not.toBeNull(); });
        await vi.waitFor(async () => { await flushHookEffects(); await act(async () => {
            expect(await executor.execute('ui.prompts.picker.select', { composerRef: ref, selection: { kind: 'doc', artifactId } }, {
                surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'picker-account',
            })).toMatchObject({ ok: true, result: { status: 'selected' } });
        }); });
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'ui.prompts.picker.apply': { disabledSurfaces: ['ui'] },
        } });
        homes.answer(serverId, '/v2/account/settings', { body: { version: 3, content: { t: 'plain', v: { actionsSettingsV1 } } } });
        storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1 } }));
        expect(await executor.execute('ui.prompts.picker.apply', { composerRef: ref, mode: 'insert' }, {
            surface: 'ui', serverId, expectedAccountId: 'picker-account',
        })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await act(async () => { await screen.findByTestId('prompt-picker-search')?.props.onSubmitEditing?.(); });
        expect(input.stateRef.current.text).toBe('before Review  please after');
        expect(input.sent).toEqual([]);
    });

    it.each([
        { name: 'Session', ref: { kind: 'session', sessionId: 'picker-session' } },
        { name: 'shared Home/New document', ref: { kind: 'newSession', instanceId: 'new-composer' } },
    ] satisfies readonly { name: string; ref: ComposerRefV1 }[])('selects and inserts on $name, preserving the argument caret', async ({ ref }) => {
        const { serverId, artifactId } = await seed();
        const input = mountedInput();
        await renderScreen(<MountedPicker serverId={serverId} composerRef={ref} input={input} />);
        const executor = createDefaultActionExecutor();
        const signal = new AbortController().signal;
        // React Native's installed abort-controller signal has events/aborted but no method.
        Object.defineProperty(signal, 'throwIfAborted', { value: undefined });
        const context = { surface: 'mcp', serverId, expectedAccountId: 'picker-account', bypassApprovals: true, signal } as const;
        await act(async () => { expect(await executor.execute('ui.prompts.picker.open', { composerRef: ref }, context)).toMatchObject({ ok: true, result: { status: 'opened' } }); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            await act(async () => { expect(await executor.execute('ui.prompts.picker.select', { composerRef: ref,
                selection: { kind: 'doc', artifactId } }, context)).toMatchObject({ ok: true, result: { status: 'selected' } }); });
        });
        await act(async () => { expect(await executor.execute('ui.prompts.picker.apply', { composerRef: ref, mode: 'insert' }, context)).toMatchObject({ ok: true, result: { status: 'applied' } }); });
        expect(input.stateRef.current).toEqual({ text: 'before Review  please after', selection: { start: 14, end: 14 } });
        expect(input.sent).toEqual([]);
    });

    it('sends through the host, refuses a stale draft, and never falls through to a different composer', async () => {
        const { serverId, artifactId } = await seed();
        const ref = { kind: 'session', sessionId: 'picker-session' } as const;
        const input = mountedInput();
        await renderScreen(<MountedPicker serverId={serverId} composerRef={ref} input={input} />);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent', serverId, expectedAccountId: 'picker-account', bypassApprovals: true } as const;
        const openAndSelect = async () => {
            await act(async () => { await executor.execute('ui.prompts.picker.open', { composerRef: ref }, context); });
            await vi.waitFor(async () => { await flushHookEffects(); await act(async () => {
                expect(await executor.execute('ui.prompts.picker.select', { composerRef: ref, selection: { kind: 'doc', artifactId } }, context))
                    .toMatchObject({ ok: true, result: { status: 'selected' } });
            }); });
        };
        await openAndSelect();
        await act(async () => { expect(await executor.execute('ui.prompts.picker.apply', { composerRef: ref, mode: 'send' }, context))
            .toMatchObject({ ok: true, result: { status: 'applied' } }); });
        expect(input.sent).toEqual(['before Review  please after']);
        await openAndSelect();
        input.stateRef.current = { text: 'newer draft', selection: { start: 11, end: 11 } };
        await act(async () => { expect(await executor.execute('ui.prompts.picker.apply', { composerRef: ref, mode: 'send' }, context))
            .toMatchObject({ ok: true, result: { status: 'refused' } }); });
        expect(input.stateRef.current.text).toBe('newer draft'); expect(input.sent).toEqual(['before Review  please after']);
        await act(async () => { expect(await executor.execute('ui.prompts.picker.apply', { composerRef: { kind: 'session', sessionId: 'other' }, mode: 'insert' }, context))
            .toMatchObject({ ok: true, result: { status: 'noEligibleComposer' } }); });
    });
});
