import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type {
  PluginUiHostApi,
  RenderContext,
  ResourceContent,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';

import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } from '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts';
import { readBundledPluginUiAppArtifactAssetBytes } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactAssetReader';
import { evaluatePluginUiCommonJsBundle } from '@/components/plugins/reactNative/commonJsEvaluator';
import type { PluginReactNativeSurfaceModule } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import {
  projectPluginUiHostPalette,
  readPluginUiHostTypography,
} from '@/components/plugins/surfaces/pluginUiThemeProjection';

/**
 * Dev-only: mounts one bundled plugin artifact (the bytes Home would run) with a fixture Host API, so a
 * `/dev` specimen shows a plugin surface's real rendering without a Machine. Every unanswered method throws.
 */

export type BundledPluginFixtureAnswers = Readonly<{
  /** The fixture's answer per Action local id or host Action id. */
  executeAction?: (actionId: string, input: unknown) => Promise<unknown>;
  readResource?: (localId: string) => Promise<ResourceContent>;
}>;

export function createBundledPluginFixtureHostApi(
  context: SurfaceContext,
  answers: BundledPluginFixtureAnswers,
  label: string,
): PluginUiHostApi {
  const unsupported = async (): Promise<never> => {
    throw new Error(`The ${label} fixture does not support this.`);
  };
  return {
    version: () => ({
      apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
      wireVersion: 1,
      methods: [
        'context',
        'readResource',
        'executeAction',
        'admitAction',
        'openSurface',
        'openExternalLink',
      ],
    }),
    context: async () => context,
    widgetArea: unsupported,
    actionControl: unsupported,
    downloadFile: unsupported,
    watchContext: async () => ({ dispose() {} }),
    executeAction: (async (action: unknown, input?: unknown) => {
      if (!answers.executeAction) return await unsupported();
      const actionId = typeof action === 'string' ? action : (action as { localId: string }).localId;
      return await answers.executeAction(actionId, input);
    }) as PluginUiHostApi['executeAction'],
    selectActionInput: unsupported,
    admitAction: async () => true,
    readEntityDragItem: unsupported,
    updateEntityDragDrop: unsupported,
    watchEntityDragDrop: unsupported,
    openNewSession: unsupported,
    openManagedMachineConfiguration: unsupported,
    openDeployment: unsupported,
    openAutomationEvent: unsupported,
    revealSessionInput: unsupported,
    pickWorkspaceFile: unsupported,
    openConnectedAccounts: unsupported,
    settleEphemeralInput: unsupported,
    readResource: (async (resource: unknown) => {
      if (!answers.readResource) return await unsupported();
      return await answers.readResource(
        typeof resource === 'string'
          ? resource
          : (resource as { localId: string }).localId,
      );
    }) as PluginUiHostApi['readResource'],
    statOpenableContent: async () => ({ status: 'unsupported' as const }),
    readOpenableContent: async () => ({ status: 'unsupported' as const }),
    readStoredImage: unsupported,
    watchLiveStream: unsupported,
    watchResource: unsupported,
    activeComposer: unsupported,
    readComposer: unsupported,
    readDiscussionComposer: unsupported,
    watchComposer: unsupported,
    applyComposer: unsupported,
    focusComposer: unsupported,
    setComposerDecorations: unsupported,
    acquireComposerInputLock: unsupported,
    pickComposerMedia: unsupported,
    inspectComposerContent: unsupported,
    releaseComposerContent: unsupported,
    readSession: async () => null,
    readMachineDisplayName: async () => ({ status: 'unavailable' }),
    watchSession: unsupported,
    respondToSessionPermission: async () => ({
      status: 'refused',
      reason: 'sessionUnavailable',
    }),
    publishCurrentUiContext: () => undefined,
    openSurface: async () => undefined,
    openResource: unsupported,
    replacePageLocation: unsupported,
    setPageNavigation: unsupported,
    setUnsavedChanges: unsupported,
    deviceState: unsupported,
    notify: async () => undefined,
    confirm: async () => false,
    diagnostic: () => undefined,
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    openExternalLink: async () => undefined,
  } satisfies PluginUiHostApi;
}

/** The bundled artifact's `renderSurface`, evaluated once from the app's own artifact inventory. */
export function useBundledPluginSurfaceModule(
  pluginId: string,
  artifactId: string,
): PluginReactNativeSurfaceModule | null {
  const artifact = BUNDLED_PLUGIN_UI_APP_ARTIFACTS.find(
    (entry) =>
      entry.pluginId === pluginId &&
      entry.artifactId === artifactId &&
      entry.tier === 'reactNative',
  );
  const [loaded, setLoaded] = React.useState<Readonly<{
    artifact: typeof artifact;
    module: PluginReactNativeSurfaceModule;
  }> | null>(null);
  React.useEffect(() => {
    let active = true;
    const entry = artifact?.files.find((file) =>
      file.relativePath.endsWith('/entry.cjs.bundle'),
    );
    if (!artifact || !entry) return;
    void (async () => {
      const bytes = await readBundledPluginUiAppArtifactAssetBytes(entry.asset);
      if (!bytes || !active) return;
      const renderSurface = evaluatePluginUiCommonJsBundle({
        bytes,
        identity: {
          pluginId: artifact.pluginId,
          artifactId: artifact.artifactId,
          digest: artifact.digest,
        },
        requestedExport: 'renderSurface',
      }) as PluginReactNativeSurfaceModule['renderSurface'];
      if (active) setLoaded({ artifact, module: { renderSurface } });
    })().catch(() => {
      if (active) setLoaded(null);
    });
    return () => {
      active = false;
    };
  }, [artifact]);
  return loaded?.artifact === artifact ? (loaded?.module ?? null) : null;
}

/** One fixture mount: the module's element with the host's presentation (palette, type, header binding). */
export function BundledPluginSurfaceMount(
  props: Readonly<{
    module: PluginReactNativeSurfaceModule | null;
    pluginId: string;
    displayName: string;
    context: SurfaceContext;
    hostApi: PluginUiHostApi;
    launchInput?: RenderContext['launchInput'];
    /** The page location a page surface opens at, as the host's page route would deliver it. */
    subPath?: string;
    presentation?: Omit<
      Parameters<typeof createPluginUiPrivatePresentationHost>[1],
      'palette' | 'typography'
    >;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const presentationHost = React.useMemo(
    () =>
      createPluginUiPrivatePresentationHost(
        { displayName: props.displayName },
        {
          palette: projectPluginUiHostPalette(theme),
          typography: readPluginUiHostTypography(theme),
          ...props.presentation,
        },
      ),
    [props.displayName, props.presentation, theme],
  );
  return React.useMemo(() => {
    if (!props.module) return null;
    const renderContext = Object.freeze({
      plugin: Object.freeze({ id: props.pluginId, version: '0.0.0' }),
      surface: props.context,
      hostApi: props.hostApi,
      activity: Object.freeze({ active: true }),
      signal: new AbortController().signal,
      ...(props.launchInput === undefined
        ? {}
        : { launchInput: props.launchInput }),
      ...(props.subPath === undefined ? {} : { subPath: props.subPath }),
    }) satisfies RenderContext;
    const entry = props.module.renderSurface(renderContext);
    return entry
      ? React.cloneElement(
          entry as React.ReactElement<Record<string, unknown>>,
          { presentationHost },
        )
      : null;
  }, [
    presentationHost,
    props.context,
    props.hostApi,
    props.launchInput,
    props.module,
    props.pluginId,
    props.subPath,
  ]);
}
