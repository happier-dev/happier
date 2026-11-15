import { normalizeSessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { normalizeProjectRememberedSelectionId } from '@/components/workspaceCockpit/project/projectCockpitState';
import { createPersistentUiState } from './persistentUiState';
import { MachineVitalsHistoryV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { TabType } from '@/components/ui/navigation/tabTypes';

// Workflows owns its route; only the shell's retained tab bodies are restored here.
function parseMainAppTab(value: unknown): Exclude<TabType, 'workflows'> {
    return value === 'projects' || value === 'inbox' ? value : 'sessions';
}
export const MAIN_APP_TAB_UI_KEY = 'active';
export const mainAppTabState = createPersistentUiState('main-app-tab-v1', parseMainAppTab);

/** Import the previous device carrier at startup; Account KV stays untouched. */
export function migrateMainAppTabFromSettings(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const stored = input as Record<string, unknown>;
    if (!Object.hasOwn(stored, 'mainAppTab')) return input;
    if (mainAppTabState.readStrict(MAIN_APP_TAB_UI_KEY) === undefined) {
        mainAppTabState.set(MAIN_APP_TAB_UI_KEY, parseMainAppTab(stored.mainAppTab));
    }
    const { mainAppTab: _legacyTab, ...retained } = stored;
    return retained;
}

// Navigation observations use the same device KV/lifecycle as panes and drafts.
// The domain normalizers, not Settings, own the set of admitted surfaces.
export const sessionLastMobileSurfaceState = createPersistentUiState('session-mobile-surfaces-v1', value => {
    const surface = typeof value === 'string' ? normalizeSessionMobileSurface(value) : null;
    return surface !== null && surface === value ? surface : undefined;
});
export const projectLastMobileSurfaceState = createPersistentUiState('project-mobile-surfaces-v1', value => {
    const surface = typeof value === 'string' ? normalizeProjectRememberedSelectionId(value) : null;
    return surface !== null && surface === value ? surface : undefined;
});
export const projectLastActiveRootPathState = createPersistentUiState('project-active-root-paths-v1',
    value => typeof value === 'string' ? value : undefined);
export const projectLastActiveWorktreeIdState = createPersistentUiState('project-active-worktree-ids-v1',
    value => typeof value === 'string' ? value : undefined);

const parseMachineVitalsRange = (value: unknown) => {
    const result = MachineVitalsHistoryV1Schema.shape.range.safeParse(value);
    return result.success ? result.data : undefined;
};
export const MACHINE_VITALS_RANGE_UI_KEY = 'range';
export const machineVitalsRangeState = createPersistentUiState('machine-vitals-range-v1', parseMachineVitalsRange);

/** 0.2's device-local Session map is imported once, before Settings retires it. */
export function migrateSessionMobileSurfacesFromSettings(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const stored = input as Record<string, unknown>;
    if (!Object.hasOwn(stored, 'sessionLastMobileSurfaceBySessionId')) return input;
    const surfaces = stored.sessionLastMobileSurfaceBySessionId;
    if (surfaces && typeof surfaces === 'object' && !Array.isArray(surfaces)) {
        for (const [key, value] of Object.entries(surfaces)) {
            const surface = typeof value === 'string' ? normalizeSessionMobileSurface(value) : null;
            if (!surface || surface !== value) continue;
            // A partial-copy retry must not overwrite a later current-owner write.
            if (sessionLastMobileSurfaceState.readStrict(key) === undefined) sessionLastMobileSurfaceState.set(key, surface);
        }
    }
    const { sessionLastMobileSurfaceBySessionId: _legacySurfaces, ...retained } = stored;
    return retained;
}
