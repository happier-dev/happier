import { describe, expect, it } from 'vitest';
import { buildProjectPaneScopeId } from './projectPaneScope';

describe('project pane scope', () => {
    it('isolates duplicate destination panes while retaining the native scope when no instance is supplied', () => {
        expect(buildProjectPaneScopeId('project-a')).toBe('project:project-a');
        expect(buildProjectPaneScopeId('project-a', null, 'tab:a')).not.toBe(buildProjectPaneScopeId('project-a', null, 'tab:b'));
        expect(buildProjectPaneScopeId('project-a', null, 'tab:a')).not.toBe(buildProjectPaneScopeId('project-a'));
    });
    it('isolates duplicate Project ids by their Home before destination-instance qualification', () => {
        expect(buildProjectPaneScopeId('project-a', 'home-a')).toBe('project:home-a:project-a');
        expect(buildProjectPaneScopeId('project-a', 'home-a')).not.toBe(buildProjectPaneScopeId('project-a', 'home-b'));
        expect(buildProjectPaneScopeId('a:b', 'home')).not.toBe(buildProjectPaneScopeId('b', 'home:a'));
    });
});
