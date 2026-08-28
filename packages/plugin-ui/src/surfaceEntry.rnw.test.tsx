import { act, cloneElement, useEffect, type ReactElement } from 'react';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { ComposerRefV1, RenderContext, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { Text } from './components/Text.js';
import { Markdown } from './components/Content.js';
import { Menu } from './components/Overlay.js';
import { usePluginTheme, useSurfaceContext } from './components/PluginUiProvider.js';
import { usePluginUiDataClient, type PluginUiDataClient } from './data/index.js';
import { createUnavailablePluginUiAccountKv } from './data/accountKv.js';
import { createUnavailablePluginUiAccountSettings } from './data/accountSettings.js';
import {
  useComposer,
  usePluginResource,
  usePluginSurfaceActivity,
  usePluginUiEphemeralSharedScope,
  type PluginUiEphemeralSharedScope,
} from './hostApi/index.js';
import type { PluginUiPresentationHost } from './presentationHost/context.js';
import { mountThroughReactNativeWebAsync } from './rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from './surfaceFixture.testSupport.js';
import { defineUiSurface } from './surfaceEntry.js';

function createRenderContext(
  surface: SurfaceContext,
  hostApi = createHostApiStub(surface),
  privateCarrier?: unknown,
  launchInput?: RenderContext['launchInput'],
): RenderContext {
  const context = {
    plugin: Object.freeze({ id: 'example.plugin-ui', version: '1.0.0' }),
    surface,
    hostApi,
    signal: new AbortController().signal,
    ...(launchInput === undefined ? {} : { launchInput }),
  } satisfies RenderContext;
  if (privateCarrier !== undefined) {
    Object.defineProperty(
      context,
      Symbol.for('happier.pluginUi.privateHostedWebCollectionUiQueryTransport.v1'),
      {
        value: privateCarrier,
        enumerable: false,
        configurable: false,
        writable: false,
      },
    );
  }
  return Object.freeze(context);
}

function installHostedComposerPrivateCarrier(
  context: RenderContext,
  composerRef: ComposerRefV1,
): RenderContext {
  const hostedContext = { ...context } satisfies RenderContext;
  Object.defineProperty(
    hostedContext,
    Symbol.for('happier.pluginUi.privateMountedComposerRef.v1'),
    {
      value: composerRef,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  );
  return Object.freeze(hostedContext);
}

/** Mirrors the host's post-`renderSurface` provider binding step. */
function installPrivateHostBindings(
  entry: ReactElement,
  bindings: Readonly<{
    accountLifetime?: unknown;
    resourceStoreGeneration?: unknown;
    composerRef?: ComposerRefV1;
    presentationHost?: unknown;
    dataClient?: PluginUiDataClient;
  }>,
): ReactElement {
  return cloneElement(
    entry as ReactElement<Record<string, unknown>>,
    bindings,
  );
}

let presentationAuthorContext: RenderContext | undefined;

function PresentationAuthorSurface(context: RenderContext) {
  presentationAuthorContext = context;
  return <Markdown value="**delegated**" testID="delegated-markdown" />;
}

let menuAuthorContext: RenderContext | undefined;
let menuOnOpenChange: ReturnType<typeof vi.fn> | undefined;

function MenuAuthorSurface(context: RenderContext) {
  menuAuthorContext = context;
  return (
    <Menu
      open
      onOpenChange={(open) => menuOnOpenChange?.(open)}
      trigger="Actions"
      triggerAccessibilityLabel="Open actions"
      items={[{ id: 'inspect', label: 'Inspect' }]}
      onSelect={() => undefined}
    />
  );
}

/**
 * An author surface that installs NO provider of its own — the normal §3.9
 * authoring shape, and the exact shape that crashes today because production
 * never installs one either.
 */
function AuthorSurface() {
  const { locale } = useSurfaceContext();
  const theme = usePluginTheme();
  return <Text value={`${locale}:${theme.colors.accent}`} testID="author-text" />;
}

let resourceAuthorContext: RenderContext | undefined;

function ResourceAuthorSurface(context: RenderContext) {
  resourceAuthorContext = context;
  const { resource } = usePluginResource('example.plugin-ui.status');
  return <Text value={`${resource.pending}:${resource.freshness}`} testID="resource-state" />;
}

let dataAuthorContext: RenderContext | undefined;
let expectedDataClient: PluginUiDataClient | undefined;

function DataAuthorSurface(context: RenderContext) {
  dataAuthorContext = context;
  const client = usePluginUiDataClient();
  return <Text
    value={client === expectedDataClient ? 'data-client-bound' : 'data-client-missing'}
    testID="data-client-state"
  />;
}

let hostedDataAuthorContext: RenderContext | undefined;
let hostedDataClient: PluginUiDataClient | undefined;

function HostedDataAuthorSurface(context: RenderContext) {
  hostedDataAuthorContext = context;
  hostedDataClient = usePluginUiDataClient();
  return <Text value="hosted-data-client-bound" testID="hosted-data-client-state" />;
}

let hostedEphemeralAuthorContext: RenderContext | undefined;
let hostedEphemeralScope: PluginUiEphemeralSharedScope | null | undefined;

function HostedEphemeralAuthorSurface(context: RenderContext) {
  hostedEphemeralAuthorContext = context;
  hostedEphemeralScope = usePluginUiEphemeralSharedScope();
  return <Text
    value={hostedEphemeralScope === null ? 'ephemeral-scope-unavailable' : 'ephemeral-scope-bound'}
    testID="hosted-ephemeral-scope-state"
  />;
}

let composerCurrentRef: ComposerRefV1 | null | undefined;
let composerAuthorContext: RenderContext | undefined;

function ComposerAuthorSurface(context: RenderContext) {
  composerAuthorContext = context;
  composerCurrentRef = useComposer().current()?.ref ?? null;
  return <Text
    value={composerCurrentRef === null ? 'composer-unbound' : 'composer-bound'}
    testID="composer-current-state"
  />;
}

let activityAuthorContext: RenderContext | undefined;
let activityMounts = 0;
function ActivityAuthorSurface(context: RenderContext) {
  activityAuthorContext = context;
  const activity = usePluginSurfaceActivity();
  useEffect(() => {
    activityMounts += 1;
  }, []);
  return <Text value={activity.active ? 'surface-active' : 'surface-inactive'} testID="surface-activity" />;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('defineUiSurface', () => {
  it('projects host-owned activity into a retained author surface', async () => {
    activityMounts = 0;
    const surface = createSurfaceContext();
    const context = Object.freeze({
      ...createRenderContext(surface),
      activity: Object.freeze({ active: true }),
    }) satisfies RenderContext;
    const mount = await mountThroughReactNativeWebAsync(
      defineUiSurface(ActivityAuthorSurface)(context) as ReactElement,
    );

    expect(mount.container.textContent).toBe('surface-active');
    expect(activityAuthorContext?.activity).toEqual({ active: true });
    const inactiveContext = Object.freeze({
      ...context,
      activity: Object.freeze({ active: false }),
    }) satisfies RenderContext;
    await mount.render(defineUiSurface(ActivityAuthorSurface)(inactiveContext) as ReactElement);
    expect(mount.container.textContent).toBe('surface-inactive');
    expect(activityMounts).toBe(1);
    mount.unmount();
  });

  it('carries current Composer only from the host-private mounted carrier', async () => {
    const surface = createSurfaceContext();
    const composer = Object.freeze({
      kind: 'session' as const,
      sessionId: 'hosted-composer-session',
    }) satisfies ComposerRefV1;
    const canonicalLaunchInput = Object.freeze({
      v: 1 as const,
      role: 'region' as const,
      composer,
      regionLocalId: 'composer-region',
    });
    const renderSurface = defineUiSurface(ComposerAuthorSurface);

    // This is schema-valid Composer mount JSON but an ordinary destination
    // author may supply it too. Public launch input alone never establishes
    // mounted-composer currentness.
    composerCurrentRef = undefined;
    composerAuthorContext = undefined;
    const genericMount = await mountThroughReactNativeWebAsync(
      renderSurface(createRenderContext(
        surface,
        createHostApiStub(surface),
        undefined,
        canonicalLaunchInput,
      )) as ReactElement,
    );

    expect(genericMount.container.textContent).toBe('composer-unbound');
    expect(composerCurrentRef).toBeNull();
    expect(Reflect.get(
      composerAuthorContext,
      Symbol.for('happier.pluginUi.privateMountedComposerRef.v1'),
    )).toBeUndefined();
    genericMount.unmount();

    // Hosted bootstrap transports the exact host-stamped ref in its private
    // carrier; the public author context still receives only launch input.
    composerCurrentRef = undefined;
    composerAuthorContext = undefined;
    const hostedMount = await mountThroughReactNativeWebAsync(
      renderSurface(installHostedComposerPrivateCarrier(
        createRenderContext(
          surface,
          createHostApiStub(surface),
          undefined,
          canonicalLaunchInput,
        ),
        composer,
      )) as ReactElement,
    );

    expect(hostedMount.container.textContent).toBe('composer-bound');
    expect(composerCurrentRef).toEqual(composer);
    expect(Reflect.get(
      composerAuthorContext,
      Symbol.for('happier.pluginUi.privateMountedComposerRef.v1'),
    )).toBeUndefined();
    expect(composerAuthorContext).not.toHaveProperty('composerRef');
    hostedMount.unmount();

    // RN/RNW hosts add the exact Composer ref only after arbitrary
    // `renderSurface` code returns the conventional provider element.
    composerCurrentRef = undefined;
    const canonicalMount = await mountThroughReactNativeWebAsync(
      installPrivateHostBindings(renderSurface(createRenderContext(
        surface,
        createHostApiStub(surface),
        undefined,
        canonicalLaunchInput,
      )) as ReactElement, { composerRef: composer }),
    );

    expect(canonicalMount.container.textContent).toBe('composer-bound');
    expect(composerCurrentRef).toEqual(composer);
    canonicalMount.unmount();
  });

  it('installs the environment around the author surface from the render context alone', async () => {
    const surface = createSurfaceContext({ locale: 'de' });
    const renderSurface = defineUiSurface(AuthorSurface);

    const mount = await mountThroughReactNativeWebAsync(
      renderSurface(createRenderContext(surface)) as ReactElement,
    );

    expect(mount.container.textContent).toBe(`de:${surface.theme.colors.accent}`);
    mount.unmount();
  });

  /**
   * The negative control that makes the positive meaningful: the SAME author
   * component, returned from a `renderSurface` that does not wrap it, fails.
   * Without this, the test above would also pass against an implementation that
   * did nothing, if some other provider happened to be mounted.
   */
  it('is what supplies the environment — an unwrapped author surface still fails', async () => {
    await expect(
      mountThroughReactNativeWebAsync(<AuthorSurface />),
    ).rejects.toThrow(/PluginUiProvider is required/u);
  });

  it('keeps the surface reactive: watchContext drives after the seeded first paint', async () => {
    const initial = createSurfaceContext({ locale: 'en' });
    let publish: ((context: SurfaceContext) => void) | undefined;
    const hostApi = createHostApiStub(initial, {
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        publish = listener;
        return { dispose() {} };
      },
    });
    const renderSurface = defineUiSurface(AuthorSurface);

    const mount = await mountThroughReactNativeWebAsync(
      renderSurface(createRenderContext(initial, hostApi)) as ReactElement,
    );
    expect(mount.container.textContent).toBe(`en:${initial.theme.colors.accent}`);

    const { act } = await import('react');
    await act(async () => {
      publish?.({
        ...initial,
        locale: 'fr',
        theme: { ...initial.theme, colors: { ...initial.theme.colors, accent: '#00ff00' } },
      });
    });

    expect(mount.container.textContent).toBe('fr:#00ff00');
    mount.unmount();
  });

  it('consumes a host-installed Resource lifetime without exposing it to the author surface', async () => {
    resourceAuthorContext = undefined;
    const surface = createSurfaceContext();
    const read = createDeferred<Awaited<ReturnType<ReturnType<typeof createHostApiStub>['readResource']>>>();
    let current = true;
    const retireListeners = new Set<() => void>();
    const accountLifetime = {
      isCurrent: () => current,
      onRetire(cancel: () => void) {
        retireListeners.add(cancel);
        return { dispose: () => retireListeners.delete(cancel) };
      },
    };
    const hostApi = createHostApiStub(surface, {
      readResource: vi.fn(() => read.promise),
    });
    const renderSurface = defineUiSurface(ResourceAuthorSurface);
    const context = createRenderContext(surface, hostApi);

    const mount = await mountThroughReactNativeWebAsync(installPrivateHostBindings(
      renderSurface(context) as ReactElement,
      { accountLifetime, resourceStoreGeneration: 'generation-a' },
    ));
    expect(mount.container.textContent).toBe('initial:unknown');
    expect('accountLifetime' in context).toBe(false);
    expect(Object.keys(context)).not.toContain('accountLifetime');
    const authorContext = resourceAuthorContext;
    expect(authorContext).toBeDefined();
    if (!authorContext) throw new Error('The author surface did not receive a render context.');
    expect('accountLifetime' in authorContext).toBe(false);
    expect(Object.getOwnPropertySymbols(authorContext)).toEqual([]);

    const { act } = await import('react');
    await act(async () => {
      current = false;
      for (const retire of [...retireListeners]) retire();
      read.resolve({
        contentType: 'application/json',
        digest: `sha256:${'f'.repeat(64)}`,
        bytes: new TextEncoder().encode('{"status":"late"}'),
      });
      await Promise.resolve();
    });

    // Account retirement clears the provider-local store before the deferred
    // Account-A read settles. The important negative is that it never reaches
    // the author as a fresh value.
    expect(mount.container.textContent).toBe('idle:unknown');
    mount.unmount();
  });

  it('carries the Data client only through the private entry provider', async () => {
    dataAuthorContext = undefined;
    const surface = createSurfaceContext();
    const client: PluginUiDataClient = Object.freeze({
      collection: () => {
        throw new Error('The test author surface does not use direct collection operations.');
      },
      openCollectionQuery: async () => {
        throw new Error('The test author surface does not open a query.');
      },
      accountKv: createUnavailablePluginUiAccountKv(),
      accountSettings: createUnavailablePluginUiAccountSettings(),
    });
    expectedDataClient = client;
    const renderSurface = defineUiSurface(DataAuthorSurface);
    const context = createRenderContext(surface, createHostApiStub(surface));

    const mount = await mountThroughReactNativeWebAsync(installPrivateHostBindings(
      renderSurface(context) as ReactElement,
      { dataClient: client },
    ));
    expect(mount.container.textContent).toBe('data-client-bound');
    expect('dataClient' in context).toBe(false);
    expect(Object.keys(context)).not.toContain('dataClient');
    expect(dataAuthorContext).toBeDefined();
    if (!dataAuthorContext) throw new Error('The author surface did not receive a render context.');
    expect('dataClient' in dataAuthorContext).toBe(false);
    expect(Object.getOwnPropertySymbols(dataAuthorContext)).toEqual([]);
    mount.unmount();
  });

  it('constructs one hosted Data proxy from the private bootstrap carrier without widening author context', async () => {
    hostedDataAuthorContext = undefined;
    hostedDataClient = undefined;
    const surface = createSurfaceContext();
    const request = vi.fn(async (operation: Readonly<{ kind: string; queryId?: string }>) => {
      if (operation.kind === 'open') {
        return {
          kind: 'snapshot',
          queryId: 'query_1',
          snapshot: { status: 'ready', rows: [], hasMore: false },
        };
      }
      if (operation.kind === 'close') return { kind: 'closed', queryId: operation.queryId };
      throw new Error('Unexpected hosted data operation.');
    });
    const acquireTransport = vi.fn(async () => Object.freeze({
      request,
      subscribe: () => ({ dispose() {} }),
      subscribeDisconnect: () => ({ dispose() {} }),
    }));
    const context = createRenderContext(
      surface,
      createHostApiStub(surface),
      Object.freeze({ kind: 'available', acquireTransport }),
    );
    const renderSurface = defineUiSurface(HostedDataAuthorSurface);

    const mount = await mountThroughReactNativeWebAsync(
      renderSurface(context) as ReactElement,
    );

    expect(mount.container.textContent).toBe('hosted-data-client-bound');
    expect(hostedDataAuthorContext).toBeDefined();
    if (!hostedDataAuthorContext || !hostedDataClient) {
      throw new Error('The hosted Data client was not installed at the private provider boundary.');
    }
    expect(Object.getOwnPropertySymbols(hostedDataAuthorContext)).toEqual([]);
    expect('dataClient' in hostedDataAuthorContext).toBe(false);

    const pager = await hostedDataClient.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    });
    expect(acquireTransport).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      kind: 'open',
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    }, undefined);
    expect(pager.getSnapshot()).toEqual({ status: 'ready', rows: [], hasMore: false });
    pager.dispose();
    mount.unmount();
  });

  it('provides one bounded typed-unavailable Data client when hosted bootstrap capability is absent', async () => {
    let unavailableDataClient: PluginUiDataClient | undefined;
    const surface = createSurfaceContext();
    const renderSurface = defineUiSurface(() => {
      unavailableDataClient = usePluginUiDataClient();
      return <Text testID="hosted-data-unavailable">hosted-data-unavailable</Text>;
    });
    const context = createRenderContext(
      surface,
      createHostApiStub(surface),
      Object.freeze({ kind: 'unavailable' }),
    );

    const mount = await mountThroughReactNativeWebAsync(
      renderSurface(context) as ReactElement,
    );

    expect(mount.container.textContent).toBe('hosted-data-unavailable');
    if (!unavailableDataClient) {
      throw new Error('The hosted unavailable Data client was not installed at the private provider boundary.');
    }
    await expect(unavailableDataClient.openCollectionQuery({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    })).rejects.toMatchObject({ code: 'plugin_collection_ui_query_unavailable' });
    await expect(unavailableDataClient.accountSettings.snapshot())
      .rejects.toMatchObject({ code: 'plugin_settings_persistence_unavailable' });
    mount.unmount();
  });

  it('returns null when the in-process private scope binding is absent', async () => {
    hostedEphemeralAuthorContext = undefined;
    hostedEphemeralScope = undefined;
    const surface = createSurfaceContext();
    const context = createRenderContext(
      surface,
      createHostApiStub(surface),
      Object.freeze({
        kind: 'available',
        acquireTransport: async () => Object.freeze({
          request: async () => {
            throw new Error('The hosted surface must not query Data while reading an ephemeral scope.');
          },
          subscribe: () => Object.freeze({ dispose() {} }),
          subscribeDisconnect: () => Object.freeze({ dispose() {} }),
        }),
      }),
    );

    const mount = await mountThroughReactNativeWebAsync(
      defineUiSurface(HostedEphemeralAuthorSurface)(context) as ReactElement,
    );

    expect(mount.container.textContent).toBe('ephemeral-scope-unavailable');
    expect(hostedEphemeralScope).toBeNull();
    expect(hostedEphemeralAuthorContext).toBeDefined();
    expect(Object.getOwnPropertySymbols(hostedEphemeralAuthorContext ?? {})).toEqual([]);
    expect(hostedEphemeralAuthorContext).not.toHaveProperty('ephemeralSharedScope');
    mount.unmount();
  });

  it('delegates semantic content through host-installed presentation bindings without exposing them', async () => {
    presentationAuthorContext = undefined;
    const surface = createSurfaceContext();
    const renderMarkdown = vi.fn((input: Readonly<{ value: string }>) => (
      <Text value={`host:${input.value}`} testID="host-markdown" />
    ));
    const renderSurface = defineUiSurface(PresentationAuthorSurface);
    const context = createRenderContext(surface, createHostApiStub(surface));

    const mount = await mountThroughReactNativeWebAsync(installPrivateHostBindings(
      renderSurface(context) as ReactElement,
      {
        presentationHost: {
          renderMarkdown,
          renderCodeBlock: ({ code }: Readonly<{ code: string }>) => <Text value={code} />,
          renderPopover: (input: Parameters<PluginUiPresentationHost['renderPopover']>[0]) => input.content({
            requestClose: () => input.onRequestClose(),
            maxHeight: 240,
          }),
          renderIcon: () => null,
        },
      },
    ));
    expect(mount.container.textContent).toBe('host:**delegated**');
    expect(renderMarkdown).toHaveBeenCalledWith({
      value: '**delegated**',
      selectable: true,
      testID: 'delegated-markdown',
    });
    expect(Object.getOwnPropertySymbols(presentationAuthorContext)).toEqual([]);
    mount.unmount();
  });

  it('carries a semantic menu to the host Popover without exposing portal authority to the author', async () => {
    menuAuthorContext = undefined;
    menuOnOpenChange = vi.fn();
    const surface = createSurfaceContext();
    const renderPopover = vi.fn((input: Parameters<PluginUiPresentationHost['renderPopover']>[0]) => input.content({
      requestClose: () => input.onRequestClose(),
      maxHeight: 240,
    }));
    const renderSurface = defineUiSurface(MenuAuthorSurface);
    const context = createRenderContext(surface, createHostApiStub(surface));

    const mount = await mountThroughReactNativeWebAsync(installPrivateHostBindings(
      renderSurface(context) as ReactElement,
      {
        presentationHost: {
          renderMarkdown: () => null,
          renderCodeBlock: () => null,
          renderPopover,
          renderIcon: () => null,
        },
      },
    ));
    const input = renderPopover.mock.calls[0]?.[0];
    expect(input).toMatchObject({ open: true, autoFocusOnOpen: true });
    expect(mount.container.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => {
      input?.onRequestClose();
    });
    expect(menuOnOpenChange).toHaveBeenCalledWith(false);
    expect(Object.getOwnPropertySymbols(menuAuthorContext)).toEqual([]);
    mount.unmount();
  });
});
