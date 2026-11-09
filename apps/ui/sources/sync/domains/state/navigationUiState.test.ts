import { beforeEach, describe, expect, it } from 'vitest';
import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { sessionLastMobileSurfaceState, projectLastMobileSurfaceState } from './navigationUiState';

beforeEach(() => clearPersistenceStorage());

describe('persisted navigation surface admission', () => {
    it('restores all declared Session surfaces while ignoring an unknown retained value', () => {
        const surfaces = ['chat', 'tabs', 'companion', ...resolveRightSidebarMobileProjection({
            scope: 'session', tabs: resolveRightSidebarTabs({ scope: 'session', presentation: 'mobile', terminalTabAvailable: true }),
        }).map(entry => entry.surface)];
        for (const surface of surfaces) {
            getPersistenceStorage().set(`ui-state:session-mobile-surfaces-v1:${surface}`, JSON.stringify(surface));
            expect(sessionLastMobileSurfaceState.read(surface)).toBe(surface);
        }
        getPersistenceStorage().set('ui-state:session-mobile-surfaces-v1:unknown', JSON.stringify('browser-preview'));
        expect(sessionLastMobileSurfaceState.read('unknown')).toBeUndefined();
    });

    it('retains canonical Project pages and every supported companion selection', () => {
        for (const surface of ['overview', 'code', 'changes', 'scripts', 'services', 'context', 'plugin:acme.tools:builds',
            'browse', 'git', 'tabs', 'terminal', 'browser']) {
            getPersistenceStorage().set(`ui-state:project-mobile-surfaces-v1:${surface}`, JSON.stringify(surface));
            expect(projectLastMobileSurfaceState.read(surface)).toBe(surface);
        }
    });
});
