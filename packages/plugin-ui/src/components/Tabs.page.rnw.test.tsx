import { act, Component, useEffect, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { View } from 'react-native';
import { Tabs } from './Tabs.js';
import { ScrollArea } from './Layout.js';
import { Text } from './Text.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import type { PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import { PluginError } from '@happier-dev/plugin-sdk';

describe('page Tabs host projection', () => {
  it('draws a page strip in the host page-tab presentation; in-body Tabs keep the underline', async () => {
    const render = (presentation: 'page' | undefined) => {
      const tabs = [<Tabs.Item key="o" value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>,
        <Tabs.Item key="f" value="files" title="Files"><Text value="Files body" /></Tabs.Item>];
      return <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        {presentation === 'page'
          ? <Tabs presentation="page" pageKind={{ pluginId: 'happier.triage', localId: 'entry' }} value="overview" onValueChange={() => {}} ariaLabel="Entry">{tabs}</Tabs>
          : <Tabs value="overview" onValueChange={() => {}} ariaLabel="Entry">{tabs}</Tabs>}
      </PluginUiProvider>;
    };
    const selectedStyle = async (presentation: 'page' | undefined) => {
      const mount = mountThroughReactNativeWeb(render(presentation));
      try {
        await act(async () => {});
        const tab = mount.container.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null;
        const style = getComputedStyle(tab!);
        return { underline: style.borderBottomWidth, fill: style.backgroundColor };
      } finally { mount.unmount(); }
    };
    const page = await selectedStyle('page');
    const inBody = await selectedStyle(undefined);
    // One page-tab presentation across built-in and plugin pages (orchestrator ruling 2026-11-04).
    expect(page.underline).not.toBe('2px');
    expect(page.fill).not.toBe('');
    expect(page.fill).not.toBe('rgba(0, 0, 0, 0)');
    expect(inBody.underline).toBe('2px');
  });
  it('keeps local tabs usable and diagnoses a failed optional page declaration', async () => {
    class Recovery extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? <Text value="Surface recovery" /> : this.props.children; }
    }
    const context = createSurfaceContext({ page: { columnVisible: true, navigation: {
      pageKind: { pluginId: 'happier.triage', localId: 'entry' }, presentation: 'bottom', tabIds: [],
    } } });
    const diagnostic = vi.fn();
    const executeAction = vi.fn();
    const host = createHostApiStub(context, {
      diagnostic, executeAction,
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }),
      setPageNavigation: async navigation => { if (navigation) throw new PluginError({ code: 'unavailable',
        details: { requestId: 'chrome-request' }, diagnostics: [{ code: 'client_control_unavailable', severity: 'warning' }] }); },
    });
    function Detail() {
      const [value, setValue] = useState('overview');
      return <Tabs presentation="page" pageKind={{ pluginId: 'happier.triage', localId: 'entry' }}
        value={value} onValueChange={setValue} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
      </Tabs>;
    }
    const mount = mountThroughReactNativeWeb(<PluginUiProvider hostApi={host} context={context}><Recovery><Detail />
    </Recovery></PluginUiProvider>);
    try {
      await act(async () => {});
      expect(mount.container.textContent).toContain('Overview body');
      await act(async () => { (mount.container.querySelector('[role="tab"][aria-label="Files"]') as HTMLElement).click(); });
      expect(mount.container.textContent).toContain('Files body');
      expect(executeAction).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'unavailable', details: {
        method: 'setPageNavigation', requestId: 'chrome-request', diagnostics: ['client_control_unavailable'],
      } }));
    } finally { mount.unmount(); }
  });
  it('keeps the shared body mounted when the host moves its strip between top and bottom', async () => {
    const pageKind = { pluginId: 'happier.triage', localId: 'entry' };
    let context = createSurfaceContext();
    const mounted = vi.fn();
    function Body() { useEffect(() => { mounted(); }, []); return <Text value="Retained body" />; }
    const host = createHostApiStub(context, {
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }),
      setPageNavigation: async () => {},
    });
    const render = () => <PluginUiProvider hostApi={host} context={context}>
      <Tabs presentation="page" pageKind={pageKind} value="overview" onValueChange={() => {}} ariaLabel="Entry" sharedPanel={<Body />}>
        <Tabs.Item value="overview" title="Overview" />
        <Tabs.Item value="files" title="Files" />
      </Tabs>
    </PluginUiProvider>;
    const mount = mountThroughReactNativeWeb(render());
    try {
      await act(async () => {});
      for (const presentation of ['bottom', 'top', 'bottom'] as const) {
        context = { ...context, page: { columnVisible: true, navigation: { pageKind, presentation, tabIds: presentation === 'bottom' ? [] : ['overview', 'files'] } } };
        await mount.render(render());
      }
      expect(mounted).toHaveBeenCalledTimes(1);
      expect(mount.container.textContent).toContain('Retained body');
    } finally { mount.unmount(); }
  });
  it('ignores a superseded declaration rejection and a retired surface late rejection', async () => {
    const diagnostic = vi.fn();
    const pending: Array<(reason: unknown) => void> = [];
    const context = createSurfaceContext();
    const host = createHostApiStub(context, {
      diagnostic,
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }),
      setPageNavigation: navigation => navigation ? new Promise<void>((_resolve, reject) => { pending.push(reject); }) : Promise.resolve(),
    });
    const render = (value: string) => <PluginUiProvider hostApi={host} context={context}>
      <Tabs presentation="page" pageKind={{ pluginId: 'happier.triage', localId: 'entry' }} value={value} onValueChange={() => {}} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
      </Tabs>
    </PluginUiProvider>;
    const mount = mountThroughReactNativeWeb(render('overview'));
    try {
      await mount.render(render('files'));
      await act(async () => { pending[0]!(new Error('Old declaration retired')); });
      expect(mount.container.textContent).toContain('Files body');
      expect(diagnostic).not.toHaveBeenCalled();
    } finally { mount.unmount(); }
    await act(async () => { pending.at(-1)!(new Error('Surface retired')); });
    expect(diagnostic).not.toHaveBeenCalled();
  });
  it.each([
    new PluginError({ code: 'stale_surface' }),
    new PluginError({ code: 'aborted' }),
    new PluginError({ code: 'unavailable', diagnostics: [{ code: 'plugin_ui_invocation_aborted', severity: 'info' }] }),
  ])('does not diagnose normal host cancellation: %s', async error => {
    const context = createSurfaceContext();
    const diagnostic = vi.fn();
    const host = createHostApiStub(context, { diagnostic,
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }),
      setPageNavigation: async navigation => { if (navigation) throw error; },
    });
    const mount = mountThroughReactNativeWeb(<PluginUiProvider hostApi={host} context={context}>
      <Tabs presentation="page" pageKind={{ pluginId: 'happier.triage', localId: 'entry' }} value="overview" onValueChange={() => {}} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
      </Tabs>
    </PluginUiProvider>);
    try {
      await act(async () => {});
      expect(mount.container.textContent).toContain('Overview body');
      expect(diagnostic).not.toHaveBeenCalled();
    } finally { mount.unmount(); }
  });
  it('ignores a tab Action rejection after the surface retires', async () => {
    const diagnostic = vi.fn();
    const choose = vi.fn();
    let rejectAction!: (error: unknown) => void;
    const context = createSurfaceContext();
    const host = createHostApiStub(context, { diagnostic,
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }),
      setPageNavigation: async () => {},
      executeAction: () => new Promise((_resolve, reject) => { rejectAction = reject; }),
    });
    const mount = mountThroughReactNativeWeb(<PluginUiProvider hostApi={host} context={context}>
      <Tabs presentation="page" pageKind={{ pluginId: 'happier.triage', localId: 'entry' }} value="session" onValueChange={choose} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="session" title="Session"><Text value="Session body" /></Tabs.Item>
      </Tabs>
    </PluginUiProvider>);
    await act(async () => { (mount.container.querySelector('[role="tab"][aria-label="Overview"]') as HTMLElement).click(); });
    mount.unmount();
    await act(async () => { rejectAction(new PluginError({ code: 'unavailable' })); });
    expect(choose).not.toHaveBeenCalled();
    expect(diagnostic).not.toHaveBeenCalled();
  });
  it('publishes Items once, keeps saved order in the detail column, settles rejected repeats and retires', async () => {
    const pageKind = { pluginId: 'happier.triage', localId: 'entry' };
    const publish = vi.fn(async (_navigation: PluginUiPageNavigationV1 | null) => {});
    const choose = vi.fn();
    let context = createSurfaceContext();
    const host = createHostApiStub(context, {
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }),
      setPageNavigation: publish,
    });
    const render = () => <PluginUiProvider hostApi={host} context={context}>
      <Text value="List column" />
      <Tabs presentation="page" pageKind={pageKind} value="overview" onValueChange={choose} ariaLabel="Entry" testID="entry-tabs">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
      </Tabs>
    </PluginUiProvider>;
    const mount = mountThroughReactNativeWeb(render());
    try {
      await act(async () => {});
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[0]).toMatchObject({ pageKind, value: 'overview', items: [{ value: 'overview' }, { value: 'files' }] });
      context = { ...context, page: { columnVisible: true, navigation: { pageKind, tabIds: ['files', 'overview'], presentation: 'top' } } };
      await mount.render(render());
      expect([...mount.container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('aria-label'))).toEqual(['Files', 'Overview']);
      expect(mount.container.querySelector('[role="tablist"]')?.textContent).not.toContain('List column');
      expect(publish).toHaveBeenCalledTimes(1);
      for (let attempt = 0; attempt < 2; attempt++) {
        context = { ...context, page: { ...context.page!, navigation: { ...context.page!.navigation!, request: 'files' } } };
        await mount.render(render());
        expect(choose).toHaveBeenCalledTimes(attempt + 1);
        expect(publish).toHaveBeenCalledTimes(attempt + 2);
        expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ value: 'overview' });
        context = { ...context, page: { ...context.page!, navigation: { ...context.page!.navigation!, request: null } } };
        await mount.render(render());
      }
      context = { ...context, colorScheme: 'dark' };
      await mount.render(render());
      expect(choose).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(3);
      expect(mount.container.textContent).toContain('Overview body');
      expect(mount.container.textContent).not.toContain('Files body');
    } finally { mount.unmount(); }
    expect(publish.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('a host request changes the controlled body once and nested host-hidden Tabs never publishes', async () => {
    const pageKind = { pluginId: 'happier.triage', localId: 'entry' };
    const publish = vi.fn(async (_navigation: PluginUiPageNavigationV1 | null) => {});
    let context = createSurfaceContext();
    const host = createHostApiStub(context, {
      version: () => ({ apiVersion: '1.1.0', wireVersion: 1, methods: ['setPageNavigation'] }), setPageNavigation: publish,
    });
    const chosen = vi.fn();
    function Detail() {
      const [value, setValue] = useState('overview');
      return <Tabs presentation="page" pageKind={pageKind} value={value} onValueChange={next => { chosen(next); setValue(next); }} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="files" title="Files"><Tabs presentation="page" pageKind={pageKind} tabList="host" value="source" onValueChange={() => {}} ariaLabel="Source">
          <Tabs.Item value="source" title="Source"><Text value="Files body" /></Tabs.Item>
        </Tabs></Tabs.Item>
      </Tabs>;
    }
    const render = () => <PluginUiProvider hostApi={host} context={context}><Detail /></PluginUiProvider>;
    const mount = mountThroughReactNativeWeb(render());
    try {
      await act(async () => {});
      context = { ...context, page: { columnVisible: true, navigation: { pageKind, presentation: 'bottom', tabIds: [], request: 'files' } } };
      await mount.render(render());
      expect(chosen).toHaveBeenCalledExactlyOnceWith('files');
      expect(mount.container.textContent).toContain('Files body');
      expect(mount.container.querySelector('[role="tablist"]')).toBeNull();
      expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ value: 'files' });
      expect(publish.mock.calls.filter(([descriptor]) => descriptor?.items.some((item: {value: string}) => item.value === 'source'))).toHaveLength(0);
    } finally { mount.unmount(); }
  });
});

describe('Tabs lead (what leads the page above its tabs)', () => {
  const lead = <Text testID="page-lead" value="Move cart totals to server-side rounding" />;
  const render = (tabList: 'shown' | 'host', nested = false) => {
    const panel = <View testID="story"><Tabs.Lead /><Text value="Overview body" /></View>;
    return <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
      <Tabs value="overview" onValueChange={() => {}} ariaLabel="Entry" tabList={tabList} lead={lead}>
        <Tabs.Item value="overview" title="Overview">
          {nested ? <Tabs value="inner" onValueChange={() => {}} ariaLabel="" tabList="host">
            <Tabs.Item value="inner" title="">{panel}</Tabs.Item>
          </Tabs> : panel}
        </Tabs.Item>
        <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
      </Tabs>
    </PluginUiProvider>;
  };

  it('stands above the tab row where the tabs draw it, and the panel does not repeat it', async () => {
    const mount = mountThroughReactNativeWeb(render('shown'));
    try {
      await act(async () => {});
      const leads = mount.container.querySelectorAll('[data-testid="page-lead"]');
      expect(leads).toHaveLength(1);
      const tablist = mount.container.querySelector('[role="tablist"]')!;
      expect(leads[0]!.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(leads[0]!.closest('[data-testid="story"]')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('leads the selected panel where the tab row is drawn elsewhere, through nested Tabs', async () => {
    for (const nested of [false, true]) {
      const mount = mountThroughReactNativeWeb(render('host', nested));
      try {
        await act(async () => {});
        const leads = mount.container.querySelectorAll('[data-testid="page-lead"]');
        expect(leads).toHaveLength(1);
        expect(leads[0]!.closest('[data-testid="story"]')).not.toBeNull();
      } finally { mount.unmount(); }
    }
  });

  it('scrolls the lead away with the selected panel, its tab row pinned inside that one scroll', async () => {
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        <Tabs value="overview" onValueChange={() => {}} ariaLabel="Entry" lead={lead} layout="fill">
          <Tabs.Item value="overview" title="Overview"><ScrollArea testID="story-scroll"><Text value="Overview body" /></ScrollArea></Tabs.Item>
          <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
        </Tabs>
      </PluginUiProvider>,
    );
    try {
      await act(async () => {});
      const scroller = mount.container.querySelector('[data-testid="story-scroll"]')!;
      const leads = mount.container.querySelectorAll('[data-testid="page-lead"]');
      expect(leads).toHaveLength(1);
      expect(scroller.contains(leads[0]!)).toBe(true);
      const tablists = mount.container.querySelectorAll('[role="tablist"]');
      expect(tablists).toHaveLength(1);
      expect(scroller.contains(tablists[0]!)).toBe(true);
      expect(leads[0]!.compareDocumentPosition(tablists[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally { mount.unmount(); }
  });

  it('keeps a short panel tall enough for the pinned row to stay under the lead when the tab switches', async () => {
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        <Tabs value="overview" onValueChange={() => {}} ariaLabel="Entry" lead={lead} layout="fill">
          <Tabs.Item value="overview" title="Overview"><ScrollArea testID="story-scroll"><Text value="Overview body" /></ScrollArea></Tabs.Item>
          <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
        </Tabs>
      </PluginUiProvider>,
    );
    try {
      await act(async () => {});
      // Layout is a native boundary: deliver the scroller's viewport and the pinned row's measured heights.
      const layout = (testID: string, height: number) => {
        const node = mount.container.querySelector(`[data-testid="${testID}"]`) as unknown as {
          __reactLayoutHandler?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
        };
        act(() => { node.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } }); });
      };
      layout('story-scroll', 600);
      layout('story-scroll:pinned-row', 44);
      const content = mount.container.querySelector<HTMLElement>('[data-testid="story-scroll:pinned-content"]');
      expect(content).not.toBeNull();
      expect(getComputedStyle(content!).minHeight).toBe('556px');
      expect(content!.textContent).toContain('Overview body');
    } finally { mount.unmount(); }
  });
});

