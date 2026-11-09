import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen as renderWithoutAuth } from '@/dev/testkit/render/renderScreen';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createPlainPromptLibraryCatalogHomeFixture, createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions';
const promptStacksRouterPushSpy = vi.hoisted(() => vi.fn());
// The real store, translation, modal, navigation hook and approval owner remain mounted.
async function renderScreen(element: React.ReactElement) {
    return renderWithoutAuth(<InjectedAuthProvider credentials={null}>{element}</InjectedAuthProvider>);
}
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'ios' }, { Switch: 'Switch' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: promptStacksRouterPushSpy } }).module;
});
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogLoad, getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { applyProfileCatalogSnapshot, beginProfileCatalogLoad, getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { usePromptStackEntries } = await import('./usePromptStackEntries');

const scope = { serverId: 'stack-catalog-home', accountId: 'stack-catalog-account' };
function publish(artifactId: string, revision: number) {
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision,
        record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [{ id: 'row-entry',
            ref: { kind: 'doc', artifactId }, enabled: true, placement: 'system_append' }] } } }],
        tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
}

describe('stack editor catalog source', () => {
    beforeEach(() => {
        resetPromptLibraryCatalogEngineForTests();
        resetProfileCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        resetProfileCatalogSnapshotsForTests();
        promptStacksRouterPushSpy.mockClear();
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://stack-catalog.invalid', generation: 1 });
        publish('doc-1', 4);
    });
    it.each(['coding', 'voice'] as const)('keeps retained %s entries readable but disables stack edits until current authority returns', async surface => {
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([{ id: 'doc-1', title: 'Instructions', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner', header: { kind: 'prompt_doc.v2', title: 'Instructions' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        const ready = { catalog: { status: 'ready' as const, rows: [{ revision: 4,
            record: { key: surface, value: { v: 1 as const, scope: { kind: surface }, entries: [{ id: 'row-entry',
                ref: { kind: 'doc' as const, artifactId: 'doc-1' }, enabled: true, placement: 'system_append' as const }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 };
        applyPromptLibraryCatalogSnapshot(scope, ready, true);
        expect(getPromptLibraryCatalogValue(scope, surface).value?.entries).toEqual(ready.catalog.rows[0].record.value.entries);
        vi.useFakeTimers();
        const screen = await renderScreen(<PromptStackEditorScreen surface={surface} title="Context" />);
        expect(getPromptLibraryCatalogValue(scope, surface).value?.entries).toEqual(ready.catalog.rows[0].record.value.entries);
        expect(screen.findHostByTestId('promptStack.entry.row-entry')).toBeTruthy();
        // The real native Switch mounts through Deferred; settle its clock before inspecting painted controls.
        await flushHookEffects({ cycles: 1, runOnlyPendingTimers: true });
        vi.useRealTimers();
        expect(screen.findHostByTestId('promptStack.entry.row-entry.enabled')).toBeTruthy();
        expect(screen.findHostByTestId('promptStack.add')).toBeTruthy();
        expect(Boolean(screen.findHostByTestId('promptStack.entry.row-entry.enabled')?.props.disabled)).toBe(false);
        expect(Boolean(screen.findHostByTestId('promptStack.add')?.props.disabled)).toBe(false);

        await act(async () => { beginPromptLibraryCatalogLoad(scope); });
        expect(screen.findHostByTestId('promptStack.entry.row-entry.enabled')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('promptStack.add')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('promptStack.entry.row-entry');
        expect(promptStacksRouterPushSpy).toHaveBeenLastCalledWith(`/settings/prompts/docs/doc-1?serverId=${scope.serverId}`);
        await screen.pressByTestIdAsync('promptStack.entry.row-entry.more');
        expect(screen.findHostByTestId('delete')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('budget.3000')?.props.disabled).toBe(true);

        await act(async () => { applyPromptLibraryCatalogSnapshot(scope, ready, true); });
        expect(Boolean(screen.findHostByTestId('promptStack.entry.row-entry.enabled')?.props.disabled)).toBe(false);
        expect(Boolean(screen.findHostByTestId('promptStack.add')?.props.disabled)).toBe(false);
        expect(Boolean(screen.findHostByTestId('delete')?.props.disabled)).toBe(false);
    });
    it('retains Profile stack content while legacy or stale authority prevents editing', async () => {
        storage.setState({ isDataReady: true });
        const profile = AIBackendProfileSchema.parse({ id: 'profile-1', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 });
        const entries = [{ id: 'profile-entry', ref: { kind: 'doc' as const, artifactId: 'doc-1' },
            enabled: true, placement: 'system_append' as const }];
        const ready = { status: 'ready' as const, source: 'destination' as const, authority: 'inactive' as const,
            control: null, controlRevision: 'absent' as const, referenceGuardRevision: 1,
            records: [{ record: ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'legacy', profile },
                enabled: true, promptStack: entries, secretBindings: {} }), revision: 3 }], diagnostics: [] };
        applyProfileCatalogSnapshot(scope, ready, true);
        vi.useFakeTimers();
        const screen = await renderScreen(<PromptStackEditorScreen surface="profile" profileId={profile.id} title="Profile Context" />);
        expect(getProfileCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', source: 'destination',
            records: [{ record: { id: profile.id, promptStack: entries } }] });
        await flushHookEffects({ cycles: 1, runOnlyPendingTimers: true });
        vi.useRealTimers();
        expect(screen.findHostByTestId('promptStack.entry.profile-entry.enabled')).toBeTruthy();
        expect(Boolean(screen.findHostByTestId('promptStack.entry.profile-entry.enabled')?.props.disabled)).toBe(false);
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(screen.findHostByTestId('promptStack.entry.profile-entry.enabled')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('promptStack.add')?.props.disabled).toBe(true);
        await act(async () => { applyProfileCatalogSnapshot(scope, { ...ready, source: 'legacy', records: [] }, true,
            new Map(), { legacyProfiles: [{ ...profile, promptStack: entries }] }); });
        expect(screen.findHostByTestId('promptStack.entry.profile-entry.enabled')?.props.disabled).toBe(true);
        await act(async () => { applyProfileCatalogSnapshot(scope, ready, true); });
        expect(Boolean(screen.findHostByTestId('promptStack.entry.profile-entry.enabled')?.props.disabled)).toBe(false);
        expect(Boolean(screen.findHostByTestId('promptStack.add')?.props.disabled)).toBe(false);
    });
    it('draws Your memory with search, + and the entry switch in both states (lab c-ctx A)', async () => {
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([{ id: 'memory-1', title: 'Memory', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner', header: { kind: 'memory_doc.v1', title: 'Memory' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 4,
            record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [{ id: 'account.memory',
                ref: { kind: 'doc', artifactId: 'memory-1' }, enabled: true, placement: 'system_append' }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const screen = await renderScreen(<PromptStackEditorScreen surface="coding" title="Context" />);
        expect(screen.findHostByTestId('context.accountMemory.search')).toBeTruthy();
        expect(screen.findHostByTestId('context.accountMemory.enabled')?.props.value).toBe(true);
    });
    it('turns an enabled Account memory off through the stack update', async () => {
        const memoryEntry = { id: 'account.memory', ref: { kind: 'doc' as const, artifactId: 'memory-1' },
            enabled: true, placement: 'system_append' as const };
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://stack-memory-switch.test', {
            key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [memoryEntry] },
        });
        onTestFinished(fixture.dispose);
        const capturedScope = storage.getState().settingsScope;
        if (!capturedScope) throw new Error('Missing admitted memory Account');
        storage.setState({ isDataReady: true });
        applyPromptLibraryCatalogSnapshot(capturedScope, { catalog: { status: 'ready', rows: [fixture.read()],
            tombstones: fixture.tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        storage.getState().applyArtifacts([{ id: 'memory-1', title: 'Memory', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: capturedScope.accountId, access: 'owner', header: { kind: 'memory_doc.v1', title: 'Memory' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        const screen = await renderScreen(<PromptStackEditorScreen surface="coding" title="Context" />);
        await act(async () => { screen.findHostByTestId('context.accountMemory.enabled')?.props.onValueChange(false); });
        await vi.waitFor(() => expect(fixture.read().record.value).toMatchObject({ entries: [{ id: 'account.memory', enabled: false }] }));
    });
    it('keeps a turned-off Account memory switch and the budget read-only while its stack catalog refreshes', async () => {
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([{ id: 'memory-1', title: 'Memory', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner', header: { kind: 'memory_doc.v1', title: 'Memory' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        const ready = { catalog: { status: 'ready' as const, rows: [{ revision: 4,
            record: { key: 'coding' as const, value: { v: 1 as const, scope: { kind: 'coding' as const }, entries: [{ id: 'account.memory',
                ref: { kind: 'doc' as const, artifactId: 'memory-1' }, enabled: false, placement: 'system_append' as const, maxChars: 3000 }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 };
        applyPromptLibraryCatalogSnapshot(scope, ready, true);
        vi.useFakeTimers();
        const screen = await renderScreen(<PromptStackEditorScreen surface="coding" title="Context" />);
        await flushHookEffects({ cycles: 1, runOnlyPendingTimers: true });
        vi.useRealTimers();
        expect(screen.findHostByTestId('context.accountMemory.enabled')).toBeTruthy();
        expect(Boolean(screen.findHostByTestId('context.accountMemory.enabled')?.props.disabled)).toBe(false);
        const loadTrigger = () => screen.findAllByTestId('context.accountMemory.load')
            .flatMap(node => node.findAll(child => typeof child.type === 'string' && child.props.accessibilityRole === 'button'))
            .find(node => typeof node.props.onPress === 'function');
        expect(loadTrigger()).toBeTruthy();
        expect(Boolean(loadTrigger()?.props.disabled)).toBe(false);
        await act(async () => { beginPromptLibraryCatalogLoad(scope); });
        expect(screen.findHostByTestId('context.accountMemory.enabled')?.props.disabled).toBe(true);
        expect(loadTrigger()?.props.disabled).toBe(true);
        const budget = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'context.accountMemory.load')!;
        expect(budget.props.items.every((item: { disabled?: boolean }) => item.disabled === true)).toBe(true);
        await act(async () => { budget.props.onSelect('1500'); });
        expect(screen.findByTestId('promptStack.updateFailed')).toBeNull();
        await act(async () => { applyPromptLibraryCatalogSnapshot(scope, ready, true); });
        expect(Boolean(screen.findHostByTestId('context.accountMemory.enabled')?.props.disabled)).toBe(false);
        expect(Boolean(loadTrigger()?.props.disabled)).toBe(false);
    });
    it.each(['coding', 'voice'] as const)('settles the mounted %s stack approval before acknowledging its captured budget edit', async surface => {
        const entries = [{ id: 'reviewed-entry', ref: { kind: 'doc' as const, artifactId: 'reviewed-prompt' },
            enabled: false, placement: 'composer_insert' as const, maxChars: 123 },
        { id: 'neighbor', ref: { kind: 'doc' as const, artifactId: 'neighbor' }, enabled: true, placement: 'system_append' as const }];
        const record: PromptLibraryRecordV1 = { key: surface, value: { v: 1, scope: { kind: surface }, entries } };
        const catalog = createPromptLibraryCatalogBoundary({ records: [record], revision: 4, settingsVersion: 7 });
        const fixture = await createPlainArtifactHomeFixture(`https://stack-${surface}-budget-approval.test`, { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 7, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'prompts.stack.update': { approvalRequiredSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        onTestFinished(fixture.dispose);
        await fixture.hydrateAccountSettings();
        await loadSyncSingletonForTests();
        const capturedScope = storage.getState().settingsScope;
        if (!capturedScope) throw new Error('Missing admitted stack Account');
        applyPromptLibraryCatalogSnapshot(capturedScope, { catalog: { status: 'ready', rows: [{ revision: 4, record }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const hook = await renderHook(() => usePromptStackEntries(surface));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().entries).toEqual(entries));
            let settled = false;
            let failure: unknown;
            let editing: Promise<void> | undefined;
            act(() => { editing = hook.getCurrent().update({ kind: 'set_budget', entryId: 'reviewed-entry', maxChars: 3001 })
                .then(() => { settled = true; }, error => { settled = true; failure = error; }); });
            await vi.waitFor(() => expect(fixture.boundary.list()).toHaveLength(1));
            const approval = fixture.boundary.list()[0]!;
            const request = StoredApprovalRequestSchema.parse(JSON.parse(fixture.boundary.readPlainBody(approval.id)!));
            expect(request).toMatchObject({ actionId: 'prompts.stack.update',
                actionArgs: { surface, expectedRevision: 4, intent: { kind: 'set_budget', entryId: 'reviewed-entry', maxChars: 3001 } } });
            const review = resolveApprovalRequestApproveAdmission(request);
            expect(review.status).toBe('available');
            expect(review.presentation.rows).toContainEqual(expect.objectContaining({ kind: 'value', path: 'intent',
                value: JSON.stringify({ kind: 'set_budget', entryId: 'reviewed-entry', maxChars: 3001 }) }));
            expect(settled).toBe(false);
            expect(catalog.requests).toEqual([]);
            await decideApprovalAsInbox(fixture.home.id, approval.id, 'approve');
            await act(async () => { await editing; });
            expect(failure).toBeUndefined();
            expect(settled).toBe(true);
            expect(catalog.revision(surface)).toBe(5);
            expect(catalog.read(surface).value).toMatchObject({ entries: [{ ...entries[0], maxChars: 3001 }, entries[1]] });
            expect(decodePlainArtifactStoredContent(fixture.boundary.read(approval.id)!.header)).toMatchObject({ approvalStatus: 'executed' });
            expect(catalog.revision(surface === 'coding' ? 'voice' : 'coding')).toBe(4);
        } finally { await hook.unmount(); }
    });
    it('retains the row identity and shows a catalog-only replacement without a preference rewrite', async () => {
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts(['doc-1', 'doc-2'].map(id => ({ id, title: id, headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner' as const, header: { kind: 'prompt_doc.v2', title: id },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true })));
        const screen = await renderScreen(<PromptStackEditorScreen surface="coding" title="Context" />);
        expect(screen.findByTestId('promptStack.entry.row-entry')).toBeTruthy();
        await act(async () => { publish('doc-2', 5); });
        expect(screen.findByTestId('promptStack.entry.row-entry')).toBeTruthy();
        await screen.pressByTestIdAsync('promptStack.entry.row-entry');
        expect(promptStacksRouterPushSpy).toHaveBeenLastCalledWith(`/settings/prompts/docs/doc-2?serverId=${scope.serverId}`);
        expect(storage.getState().settingsVersion).toBe(7);
    });

    it('adds the selected Home document alongside an identically named foreign Home reference', async () => {
        const foreignEntry = { id: 'foreign-entry', ref: { kind: 'doc' as const, artifactId: 'same-id', serverId: 'foreign-home' },
            enabled: true, placement: 'system_append' as const };
        const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://stack-picker-qualified-row.test', {
            key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [foreignEntry] },
        });
        onTestFinished(fixture.dispose);
        const capturedScope = storage.getState().settingsScope;
        if (!capturedScope) throw new Error('Missing admitted picker Account');
        // The real Artifact hook exposes the admitted list only after Account
        // hydration; this row-only fixture does not run the list sync producer.
        storage.setState({ isDataReady: true });
        applyPromptLibraryCatalogSnapshot(capturedScope, { catalog: { status: 'ready', rows: [fixture.read()],
            tombstones: fixture.tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        storage.getState().applyArtifacts([{ id: 'same-id', title: 'Local prompt', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: capturedScope.accountId, access: 'owner', header: { kind: 'prompt_doc.v2', title: 'Local prompt' },
            body: null, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true }]);
        const screen = await renderScreen(<PromptStackEditorScreen surface="coding" title="Context" />);
        await screen.pressByTestIdAsync('promptStack.add');
        // The one document menu every Context layer opens: the foreign reference does not hide this Home's document.
        const menu = screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'promptStack.addMenu')!;
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['same-id']);
        await act(async () => { menu.props.onSelect('same-id'); });
        expect(fixture.read().record.value).toMatchObject({ entries: [foreignEntry,
            { ref: { kind: 'doc', artifactId: 'same-id', serverId: fixture.home.id } }] });
        expect(fixture.mutations).toEqual([{ key: 'coding', expectedRevision: 4 }]);
        expect(fixture.settingsWrites()).toBe(0);
    });
});
