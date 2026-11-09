import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { projectLastActiveRootPathState, projectLastActiveWorktreeIdState } from './navigationUiState';
import { persistProjectSelectionUiState, readProjectSelectionUiState, useProjectSelectionUiState } from './projectSelectionUiState';

const ref = { id: 'checkout', serverId: 'home-a', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };

afterEach(async () => {
    await standardCleanup();
    replacePersistentUiStateForTest(projectLastActiveRootPathState, {});
    replacePersistentUiStateForTest(projectLastActiveWorktreeIdState, {});
});

describe('Project selection UI state', () => {
    it('keeps qualified selection live without waking for other keys or overwriting attributable bare-id memory', async () => {
        const keys = resolveProjectSelectionPreferenceKeys([ref], ref)!;
        projectLastActiveRootPathState.set(ref.id, '/repo/legacy');
        projectLastActiveWorktreeIdState.set(ref.id, 'legacy-worktree');
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useProjectSelectionUiState(keys); });
        expect(hook.getCurrent()).toEqual({ activeRootPath: '/repo/legacy', worktreeId: 'legacy-worktree' });
        const before = renders;
        await act(async () => {
            for (let index = 0; index < 20; index += 1) {
                projectLastActiveRootPathState.set(`other-${index}`, `/other-${index}`);
                projectLastActiveWorktreeIdState.set(`other-${index}`, `worktree-${index}`);
            }
        });
        expect(renders).toBe(before);
        await act(async () => persistProjectSelectionUiState(keys, '/repo/current', 'current-worktree'));
        expect(hook.getCurrent()).toEqual({ activeRootPath: '/repo/current', worktreeId: 'current-worktree' });
        expect(readProjectSelectionUiState(keys)).toEqual(hook.getCurrent());
        expect(projectLastActiveRootPathState.read(ref.id)).toBe('/repo/legacy');
        const afterQualified = renders;
        await act(async () => projectLastActiveRootPathState.set(ref.id, '/repo/hydrated-legacy'));
        expect(renders).toBe(afterQualified);
        await act(async () => projectLastActiveRootPathState.remove(keys.storageKey));
        expect(hook.getCurrent().activeRootPath).toBe('/repo/hydrated-legacy');
    });

    it('keeps duplicate ids on another Home out of selection and preserves canonical blank-value normalization', async () => {
        const other = { ...ref, serverId: 'home-b' };
        const ambiguous = resolveProjectSelectionPreferenceKeys([ref, other], other)!;
        projectLastActiveRootPathState.set(ref.id, '/foreign');
        expect(readProjectSelectionUiState(ambiguous)).toEqual({ activeRootPath: null, worktreeId: null });
        const keys = resolveProjectSelectionPreferenceKeys([ref], ref)!;
        projectLastActiveRootPathState.set(keys.storageKey, '  ');
        expect(readProjectSelectionUiState(keys).activeRootPath).toBeNull();
        expect(readProjectSelectionUiState(null)).toEqual({ activeRootPath: null, worktreeId: null });
        const hook = await renderHook(() => useProjectSelectionUiState(null));
        expect(hook.getCurrent()).toEqual(readProjectSelectionUiState(null));
    });
});
