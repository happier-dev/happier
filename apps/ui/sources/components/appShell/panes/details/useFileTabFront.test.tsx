import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { AppPaneProvider } from '../AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '../hooks/useAppPaneScope';
import { useFileTabFront, useSessionFileTabFront } from './useFileTabFront';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createWorkspaceFileDetailsTab } from './fileDetailsTab';

const initialState = storage.getState();
beforeEach(() => storage.setState(initialState, true));
afterEach(() => storage.setState(initialState, true));

describe('file tab front subscription', () => {
    it('distinguishes a repository-based tab from the same spelling under the Session cwd', async () => {
        let pane: AppPaneScopeApi | undefined;
        const selected = new Map<string, boolean>();
        function Probe({ rootPath }: { rootPath?: string }) {
            pane = useAppPaneScope('session:base');
            selected.set(rootPath ?? 'cwd', useFileTabFront('session:base', 'nested/a.ts', rootPath));
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider><Probe /><Probe rootPath="/repo" /></AppPaneProvider>);
        await act(async () => pane!.openDetailsTab(createWorkspaceFileDetailsTab('nested/a.ts', undefined, undefined, { rootPath: '/repo' }), { intent: 'pinned' }));
        expect(selected.get('/repo')).toBe(true);
        expect(selected.get('cwd')).toBe(false);
        await screen.unmount();
    });
    it('only renders chips whose selected answer changes, including closing Details', async () => {
        const renders = new Map<string, number>();
        const selected = new Map<string, boolean>();
        let pane: AppPaneScopeApi | undefined;
        function Controls() {
            pane = useAppPaneScope('session:continuity');
            return null;
        }
        const Chip = React.memo(function Chip({ path }: { path: string }) {
            const front = useFileTabFront('session:continuity', path);
            renders.set(path, (renders.get(path) ?? 0) + 1);
            selected.set(path, front);
            return null;
        });
        const screen = await renderScreen(<AppPaneProvider><Controls /><Chip path="a.ts" /><Chip path="b.ts" /><Chip path="c.ts" /></AppPaneProvider>);
        const open = (path: string) => pane!.openDetailsTab({ key: `file:${path}`, title: path, kind: 'file', resource: { kind: 'file', path } }, { intent: 'pinned' });
        await act(async () => open('a.ts'));
        const before = new Map(renders);
        await act(async () => open('b.ts'));
        expect(selected.get('a.ts')).toBe(false);
        expect(selected.get('b.ts')).toBe(true);
        expect(renders.get('a.ts')).toBe(before.get('a.ts')! + 1);
        expect(renders.get('b.ts')).toBe(before.get('b.ts')! + 1);
        expect(renders.get('c.ts')).toBe(before.get('c.ts'));
        const beforeUnrelated = new Map(renders);
        await act(async () => pane!.openRight({ tabId: 'git' }));
        expect(renders).toEqual(beforeUnrelated);
        await act(async () => pane!.closeDetails());
        expect(selected.get('b.ts')).toBe(false);
        await screen.unmount();
    });

    it('answers a transcript chip for the Session pane the opener opens its file in', async () => {
        let pane: AppPaneScopeApi | undefined;
        const scopeId = createSessionPaneScopeId('s1', 'srv1', null);
        function Controls() {
            pane = useAppPaneScope(scopeId);
            return null;
        }
        const selected = new Map<string, boolean>();
        function Chip({ sessionId, path }: { sessionId: string; path: string }) {
            selected.set(`${sessionId}:${path}`, useSessionFileTabFront(sessionId, 'srv1', path));
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider><Controls /><Chip sessionId="s1" path="a.ts" />
            <Chip sessionId="s2" path="a.ts" /></AppPaneProvider>);
        await act(async () => pane!.openDetailsTab({ key: 'file:a.ts', title: 'a.ts', kind: 'file', resource: { kind: 'file', path: 'a.ts' } }, { intent: 'pinned' }));
        expect(selected.get('s1:a.ts')).toBe(true);
        // The same path in another Session's transcript is a different tab.
        expect(selected.get('s2:a.ts')).toBe(false);
        await screen.unmount();
    });
});
