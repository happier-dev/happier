import * as React from 'react';
import { Platform } from 'react-native';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { PluginReactNativeSurface } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { createPluginSurfaceContext } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { createDemoTriageRuntime } from '@/demoMode/runtime/demoTriageRuntime';
import { createDemoPluginPresentationHost } from '@/demoMode/runtime/demoPluginPresentationHost';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { renderSurface } from '../../../../../../../../packages/plugins/triage/src/ui/surface';
import { useStagePluginSurfaceEnvironment } from './useStagePluginSurfaceEnvironment';

const module = { renderSurface };
const decision = { state: 'load', reason: 'compatible', diagnostics: [] } as const;
const SessionDetail = React.lazy(async () => ({ default: (await import('../StageSessionDetail')).StageSessionDetail }));

/** The authored PRs & Issues page; its list and durable controls keep their real owners. */
export function TriageStageSurface(): React.ReactElement {
    const environment = useStagePluginSurfaceEnvironment(Platform.OS);
    const [sessionId, setSessionId] = React.useState<string | null>(null);
    const initialSurface = React.useMemo(() => createPluginSurfaceContext({
        mount: { kind: 'destination', destination: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'triage' }, container: 'appPage' },
        target: { kind: 'app' }, accountEncryptionMode: 'plain', environment, translations: {},
    }), [environment]);
    const runtime = React.useMemo(() => createDemoTriageRuntime(initialSurface, {
        // The stage owns the demo lifetime; leaving its route restores the corpus.
        // Open the same real Session cockpit used by the other stage surfaces.
        openSession: async openedSessionId => { setSessionId(openedSessionId); },
    }), [initialSurface]);
    React.useEffect(() => () => runtime.host.dispose(), [runtime]);
    const subPath = React.useSyncExternalStore(runtime.host.pageLocation.subscribe, runtime.host.pageLocation.readSubPath, runtime.host.pageLocation.readSubPath);
    const presentationHost = React.useMemo(() => createDemoPluginPresentationHost(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, runtime.host, runtime.targetedContributions), [runtime]);
    const surface = React.useMemo(() => createPluginSurfaceContext({
        mount: initialSurface.mount, target: initialSurface.target, accountEncryptionMode: 'plain', environment, translations: {},
        accountLifetime: runtime.host.accountLifetime, targetedContributions: runtime.targetedContributions,
    }), [environment, initialSurface, runtime]);
    React.useEffect(() => runtime.host.pushSurfaceContext(surface), [runtime, surface]);
    const renderContext = React.useMemo(() => ({ plugin: { id: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, version: '0.0.0' },
        surface, hostApi: runtime.host.api, signal: runtime.host.signal, activity: { active: true }, subPath } satisfies RenderContext), [surface, runtime, subPath]);
    if (sessionId !== null) return <React.Suspense fallback={null}><SessionDetail sessionId={sessionId} /></React.Suspense>;
    return <GlassSurface plane surfaceGroup="content" finishRole={null} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <PluginReactNativeSurface surfaceId="demo-triage" decision={decision} module={module} renderContext={renderContext}
            privateHostBindings={{ presentationHost, accountLifetime: runtime.host.accountLifetime, ephemeralSharedScope: runtime.host.ephemeralSharedScope, dataClient: runtime.dataClient }} />
    </GlassSurface>;
}

