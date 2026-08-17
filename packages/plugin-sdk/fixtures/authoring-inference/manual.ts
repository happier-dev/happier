import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PresentationService } from '@happier-dev/plugin-sdk/interactions';
import type {
  PluginDynamicResourceRuntime,
  PluginResourceContextV1,
} from '@happier-dev/plugin-sdk/resources';
import type { UiView } from '@happier-dev/plugin-sdk/ui';

type PresentationHasNoActionable = 'actionable' extends keyof PresentationService ? never : true;
const presentationHasNoActionable: PresentationHasNoActionable = true;

// Dynamic resource callback options are host invocation facts. Authors may
// observe the stamped context, but do not get a separately constructible
// options vocabulary.
// @ts-expect-error PluginDynamicResourceReadOptionsV1 is host-private.
type _HostDynamicResourceReadOptions = import('@happier-dev/plugin-sdk/resources').PluginDynamicResourceReadOptionsV1;

export const contextualDynamicResource: PluginDynamicResourceRuntime = {
  read(options) {
    const context: PluginResourceContextV1 | undefined = options?.context;
    return context?.kind === 'session'
      ? `session:${context.sessionId}`
      : 'global';
  },
  observe(_invalidate, options) {
    const context: PluginResourceContextV1 | undefined = options?.context;
    void context;
    return { dispose() {} };
  },
};

export const authorInputView = {
  id: 'author-input-view',
  container: 'rightPane',
  target: { kind: 'session' },
  renderer: 'retained-renderer',
  instancePolicy: 'singleton',
  headerActions: [],
} satisfies UiView;

export const retainedSessionRightPaneView = {
  id: 'retained-session-right-pane',
  container: 'rightPane',
  target: { kind: 'session' },
  renderer: 'retained-renderer',
  instancePolicy: 'singleton',
  headerActions: [],
} satisfies UiView;

export const manifest = {
  schemaVersion: 2,
  id: 'example.manual',
  version: '0.1.0',
  displayName: 'Manual',
  engines: { happier: '>=0.0.0' },
  runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: {},
} satisfies PluginManifest;

if (false) {
  const unsupportedAppWholePaneViews = [
    // @ts-expect-error rightPane has no App target binding.
    {
      id: 'unsupported-app-right-pane',
      container: 'rightPane',
      target: { kind: 'app' },
      renderer: 'retained-renderer',
      instancePolicy: 'singleton',
      headerActions: [],
    },
    // @ts-expect-error detailsPane has no App target binding.
    {
      id: 'unsupported-app-details-pane',
      container: 'detailsPane',
      target: { kind: 'app' },
      renderer: 'retained-renderer',
      instancePolicy: 'singleton',
      headerActions: [],
    },
    // @ts-expect-error bottomPane has no App target binding.
    {
      id: 'unsupported-app-bottom-pane',
      container: 'bottomPane',
      target: { kind: 'app' },
      renderer: 'retained-renderer',
      instancePolicy: 'singleton',
      headerActions: [],
    },
  ] satisfies readonly UiView[];
  void unsupportedAppWholePaneViews;

  const invalidManifest = {
    schemaVersion: 2,
    id: 'example.invalid-app-whole-pane',
    version: '0.1.0',
    displayName: 'Invalid App whole pane',
    engines: { happier: '>=0.0.0' },
    runtime: { apiVersion: 1 },
    hostAccess: { required: [], optional: [] },
    contributes: {
      ui: {
        renderers: [{
          id: 'retained-renderer',
          kind: 'declarative',
          root: { kind: 'text', text: 'Retained' },
        }],
        views: [
          // @ts-expect-error rightPane has no App target binding in PluginManifest.
          {
            id: 'invalid-manifest-app-right-pane',
            container: 'rightPane',
            target: { kind: 'app' },
            renderer: 'retained-renderer',
          },
          // @ts-expect-error detailsPane has no App target binding in PluginManifest.
          {
            id: 'invalid-manifest-app-details-pane',
            container: 'detailsPane',
            target: { kind: 'app' },
            renderer: 'retained-renderer',
          },
          // @ts-expect-error bottomPane has no App target binding in PluginManifest.
          {
            id: 'invalid-manifest-app-bottom-pane',
            container: 'bottomPane',
            target: { kind: 'app' },
            renderer: 'retained-renderer',
          },
        ],
      },
    },
  } satisfies PluginManifest;
  void invalidManifest;
}

export function activate(): void {}
