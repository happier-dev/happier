import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createPlainPromptLibraryCatalogHomeFixture } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installPromptStacksCommonModuleMocks, promptStacksRouterPushSpy } from './promptStacksScreenTestHelpers';

installPromptStacksCommonModuleMocks({ storage: importOriginal => importOriginal() });
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

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
        resetPromptLibraryCatalogSnapshotsForTests();
        promptStacksRouterPushSpy.mockClear();
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://stack-catalog.invalid', generation: 1 });
        publish('doc-1', 4);
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
