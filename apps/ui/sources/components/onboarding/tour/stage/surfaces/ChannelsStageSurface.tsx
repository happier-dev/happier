import * as React from 'react';
import { Platform } from 'react-native';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { CONVERSATION_CORE_PLUGIN_ID_V1 } from '@happier-dev/channels-protocol/v1';

import { PluginReactNativeSurface } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { createPluginSurfaceContext } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { createDemoPluginTransport } from '@/demoMode/runtime/demoPluginTransport';
import { buildDemoChannelsWorld } from '@/demoMode/world/channels';
import { createDemoPluginPresentationHost } from '@/demoMode/runtime/demoPluginPresentationHost';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { CHANNELS_PAGE_VIEW_ID } from '../../../../../../../../packages/plugins/channels/src/sessionSurfaceIds';
import { CHANNELS_BINDINGS_RESOURCE, CHANNELS_CONNECTIONS_RESOURCE } from '../../../../../../../../packages/plugins/channels/src/ui/conversationRows';
import { renderSurface } from '../../../../../../../../packages/plugins/channels/src/ui/renderSurface';
import { useStagePluginSurfaceEnvironment } from './useStagePluginSurfaceEnvironment';

const module = { renderSurface };
const decision = { state: 'load', reason: 'compatible', diagnostics: [] } as const;

/** The authored Channels page over the existing demo world's daemon boundary. */
export function ChannelsStageSurface(): React.ReactElement {
    const environment = useStagePluginSurfaceEnvironment(Platform.OS);
    const world = React.useMemo(() => buildDemoChannelsWorld(), []);
    const surface = React.useMemo(() => createPluginSurfaceContext({
        mount: { kind: 'destination', destination: { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId: CHANNELS_PAGE_VIEW_ID }, container: 'appPage' },
        target: { kind: 'app' }, accountEncryptionMode: 'plain', environment, translations: {},
        targetedContributions: world.targetedContributions,
    }), [environment, world]);
    const host = React.useMemo(() => {
        return createDemoPluginTransport({ pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, surface,
            readResource(resource) {
                if (resource.pluginId !== CONVERSATION_CORE_PLUGIN_ID_V1) throw new Error('Unknown demo resource owner');
                if (resource.localId === CHANNELS_CONNECTIONS_RESOURCE.localId) return { connections: world.connections };
                if (resource.localId === CHANNELS_BINDINGS_RESOURCE.localId) return { bindings: world.bindings };
                throw new Error('Unknown demo Channels resource');
            },
        });
    }, [surface, world]);
    React.useEffect(() => () => host.dispose(), [host]);
    const presentationHost = React.useMemo(() => createDemoPluginPresentationHost(CONVERSATION_CORE_PLUGIN_ID_V1, host, world.targetedContributions), [host, world]);
    const renderContext = React.useMemo(() => ({ plugin: { id: CONVERSATION_CORE_PLUGIN_ID_V1, version: '0.0.0' },
        surface, hostApi: host.api, signal: host.signal, activity: { active: true } } satisfies RenderContext), [surface, host]);
    return <GlassSurface plane surfaceGroup="content" finishRole={null} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <PluginReactNativeSurface surfaceId="demo-channels" decision={decision} module={module}
            renderContext={renderContext} privateHostBindings={{ presentationHost, accountLifetime: host.accountLifetime, ephemeralSharedScope: host.ephemeralSharedScope }} />
    </GlassSurface>;
}
