/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { ProjectsTree } from './ProjectsTree';
import { buildProjectsTreeRows } from './projectsTreeRows';

it('does not reclaim focus from an editor when a previously focused Project row updates', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const rows = buildProjectsTreeRows({ projects: [{ key: 'project', name: 'Project', checkouts: [
        { refId: 'checkout', machineId: 'machine', machineName: 'Machine', label: 'main', path: '/repo', attention: null },
    ] }], openRefId: null, expandedKeys: new Set() });
    const render = () => <><ProjectsTree rows={[...rows]} onToggle={() => {}} onOpenRef={() => {}} /><textarea aria-label="Editor" /></>;
    try {
        await act(async () => root.render(render()));
        // The treeitem holds the roving tab stop; the press target inside it is out of the tab order.
        const row = container.querySelector<HTMLElement>('[data-testid="projects-tree-row-project:treeitem"]')!;
        const editor = container.querySelector('textarea')!;
        await act(async () => row.focus());
        await act(async () => editor.focus());
        expect(document.activeElement).toBe(editor);
        for (let arrival = 0; arrival < 20; arrival++) {
            await act(async () => root.render(render()));
            expect(document.activeElement).toBe(editor);
        }
        expect(row.getAttribute('tabindex')).toBe('0');
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
