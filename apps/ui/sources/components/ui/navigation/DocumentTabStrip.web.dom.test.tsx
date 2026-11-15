// @vitest-environment jsdom
import * as React from 'react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';

const legendList = vi.hoisted(() => ({ state: null as null | import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState }));
// The rail's virtualized list is a third-party rendering boundary; the testkit's recycler substitute renders its cells.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({}, state => { legendList.state = state; });
});
vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Load the external wrapper after its RN dependency resolves, then bind the app
// corridor exactly as Expo's Unistyles transform does (without a mock import cycle).
const native = await vi.importActual<typeof import('react-native')>('react-native-web');
// jsdom has no browser media-query API; the external wrapper reads it on import.
const matchMedia = (media: string): MediaQueryList => ({
    media, matches: false, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
});
vi.stubGlobal('matchMedia', matchMedia);
beforeEach(() => { vi.stubGlobal('matchMedia', matchMedia); });
const { createUnistylesElement } = await vi.importActual<typeof import('react-native-unistyles')>(
    join(dirname(createRequire(import.meta.url).resolve('react-native-unistyles/package.json')),
        'src/core/createUnistylesElement.tsx'),
);
vi.doMock('react-native', () => ({ ...native, View: createUnistylesElement(native.View) }));
const { DocumentTabStrip } = await import('./DocumentTabStrip');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['strip', 'bar', 'rail'] as const)('owns named %s tabs without absorbing their auxiliary buttons', async variant => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<DocumentTabStrip variant={variant}
            tabs={[{ key: 'file', title: 'File', isPinned: true, isPreview: false }]} activeTabKey="file"
            accessibilityLabel="Documents" onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => `tab-${id}`} panelNativeId={id => `panel-${id}`} />));
        const list = host.querySelector('[role="tablist"]')!;
        expect(list.getAttribute('aria-label')).toBe('Documents');
        expect(list.querySelector('[role="button"]')).toBeNull();
        const owned = list.getAttribute('aria-owns')?.split(' ').map(id => document.getElementById(id));
        expect(owned?.map(tab => tab?.getAttribute('role'))).toEqual(['tab']);
        expect(owned?.[0]?.getAttribute('aria-label')).toBeTruthy();
        expect(owned?.[0]?.getAttribute('aria-controls')).toBe('panel-file');
    } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each(['strip', 'bar', 'rail'] as const)('closes a %s tab through onClose on middle click and preserves primary activation', async (variant) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const closed: string[] = [];
    const activated: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<DocumentTabStrip variant={variant}
            tabs={[{ key: 'file', title: 'File', isPinned: true, isPreview: false }]}
            activeTabKey="file" accessibilityLabel="Documents" onActivate={key => activated.push(key)}
            onPin={() => {}} onUnpin={() => {}} onClose={key => closed.push(key)}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            testIds={{ tab: id => `middle-tab-${id}` }} />));
        const tab = host.querySelector<HTMLElement>('[data-testid="middle-tab-file"]')!;
        const right = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 });
        await act(async () => { tab.dispatchEvent(right); });
        expect(closed).toEqual([]);
        const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
        await act(async () => { tab.dispatchEvent(middle); });
        expect(closed).toEqual(['file']);
        expect(middle.defaultPrevented).toBe(true);
        expect(activated).toEqual([]);
        await act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); });
        expect(activated).toEqual(['file']);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('keeps a real tab carry and resized target bounded through DOM feedback commits', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let width = 300;
    // jsdom cannot measure layout; native DOM hosts, registrations and runtime remain real.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 40));
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account' };
    const applied: unknown[] = [];
    let commits = 0;
    const errors: unknown[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host, { onUncaughtError: error => errors.push(error) });
    const render = () => <React.Profiler id="tabs" onRender={() => { commits++; }}>
        <DocumentTabStrip variant="bar" tabs={[{ key: 'project', title: 'Project', isPinned: false, isPreview: false }]}
            activeTabKey="project" accessibilityLabel="Documents" onActivate={() => {}} onPin={() => {}}
            onUnpin={() => {}} onClose={() => {}} renderLeadingIcon={() => null}
            tabNativeId={id => id} panelNativeId={id => id} testIds={{ tab: id => `carry-tab-${id}` }}
            entityDragDrop={{ runtime, id: 'project-strip', scope, acceptedKinds: ['workspace-tab'],
                getItem: tabId => ({ kind: 'workspace-tab', scope, tabId }),
                resolve: ({ beforeTabId }) => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open',
                    input: { beforeTabId }, preview: { verb: 'Move', target: 'Project' } } }),
                execute: async effect => { applied.push(effect.input); return { status: 'applied' }; },
            }} />
    </React.Profiler>;
    const drag = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: 20 });
    try {
        await act(async () => root.render(render()));
        const tab = host.querySelector<HTMLElement>('[data-testid="carry-tab-project"]')!;
        const target = tab.parentElement!.parentElement!;
        await act(async () => { target.dispatchEvent(drag('dragstart')); target.dispatchEvent(drag('dragover')); });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', admission: { status: 'allowed' } });
        expect(host.querySelector('[data-testid="document-tab-drop-before-project"]')).not.toBeNull();
        for (const nextWidth of [200, 390, 300]) {
            width = nextWidth;
            await act(async () => { root.render(render()); window.dispatchEvent(new Event('resize')); await runtime.refreshMeasurements(); });
            expect(runtime.getSnapshot().phase).toBe('carrying');
        }
        await act(async () => { target.dispatchEvent(drag('drop')); });
        expect(applied).toEqual([{ beforeTabId: 'project' }]);
        expect(runtime.getSnapshot().outcome).toEqual({ status: 'applied' });
        expect(errors).toEqual([]);
        expect(commits).toBeLessThan(20);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
