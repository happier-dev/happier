import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createPlainPromptLibraryCatalogHomeFixture } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { installPromptLibrarySettingsCommonModuleMocks } from '../prompts/promptLibrarySettingsTestHelpers';

installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal() });
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { applyPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useContextBarSelection } = await import('./useContextBarSelection');

describe('Context selection catalog authority', () => {
    it.each(['updated', 'conflict'] as const)('clears a previously qualified workspace before a new target can consume it: %s', async outcome => {
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://context-binding-${outcome}.test`, {
            key: 'contexts', value: { v: 1, selectionsByKey: {
                current: { machineId: null, workspacePath: '/catalog' },
                neighbor: { machineId: null, workspacePath: '/neighbor' },
            } },
        }, outcome);
        onTestFinished(fixture.dispose);
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Missing admitted Account');
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [fixture.read()],
            tombstones: fixture.tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const rendered: { target: string; workspace: string }[] = [];
        const hook = await renderHook((props: { target: string; selectionKey: string }) => {
            const value = useContextBarSelection({ selectionKey: props.selectionKey, defaultMachineId: null,
                workspaceBindingKey: props.target });
            rendered.push({ target: props.target, workspace: value.workspacePath });
            return value;
        }, { initialProps: { target: '', selectionKey: 'current' } });
        await hook.rerender({ target: 'home-a:machine-1', selectionKey: 'current' });
        expect(hook.getCurrent().workspacePath).toBe('/catalog');
        expect(fixture.mutations).toEqual([]);
        await hook.rerender({ target: 'home-b:machine-1', selectionKey: 'current' });
        expect(rendered.filter(value => value.target === 'home-b:machine-1').every(value => value.workspace === '')).toBe(true);
        expect(hook.getCurrent().workspacePath).toBe('');
        expect(fixture.mutations).toMatchObject([{ key: 'contexts', expectedRevision: 4 }]);
        expect(fixture.read().record.value).toMatchObject({ selectionsByKey: {
            current: { workspacePath: outcome === 'updated' ? '' : '/catalog' },
            neighbor: { workspacePath: '/neighbor' },
        } });
        // A distinct selection boundary must not inherit the preceding local draft.
        await hook.rerender({ target: 'home-b:machine-1', selectionKey: 'neighbor' });
        expect(hook.getCurrent().workspacePath).toBe('/neighbor');
        expect(fixture.mutations).toHaveLength(1);
        expect(fixture.settingsWrites()).toBe(0);
    });

    it.each(['updated', 'conflict'] as const)('uses the row and retains an unacknowledged workspace choice: %s', async outcome => {
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://context-row-${outcome}.test`, {
            key: 'contexts', value: { v: 1, selectionsByKey: {
                current: { machineId: 'machine-catalog', workspacePath: '/catalog' },
                neighbor: { machineId: 'neighbor-machine', workspacePath: '/neighbor' },
            } },
        }, outcome);
        onTestFinished(fixture.dispose);
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Missing admitted Account');
        storage.setState({ settings: settingsDefaults, settingsVersion: 7 });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [fixture.read()],
            tombstones: fixture.tombstones, diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const hook = await renderHook(() => useContextBarSelection({ selectionKey: 'current', defaultMachineId: null }));
        expect(hook.getCurrent()).toMatchObject({ machineId: 'machine-catalog', workspacePath: '/catalog' });
        await act(async () => { await hook.getCurrent().setWorkspacePath('/draft'); });
        expect(hook.getCurrent().workspacePath).toBe('/draft');
        expect(fixture.mutations[0]).toMatchObject({ expectedRevision: 4 });
        expect(fixture.read().record.value).toMatchObject({ selectionsByKey: {
            current: { machineId: 'machine-catalog', workspacePath: outcome === 'updated' ? '/draft' : '/catalog' },
            neighbor: { machineId: 'neighbor-machine', workspacePath: '/neighbor' },
        } });
        expect(fixture.settingsWrites()).toBe(0);
        expect(storage.getState().settingsVersion).toBe(7);
    });
});
