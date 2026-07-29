import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeResponseEnvelopeV1,
    PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import { HostedPluginTarget } from '@/components/browser/adapters/HostedPluginTarget.web';

import type { PluginHostedWebSandboxPolicy } from './sandbox';

export function PluginHostedWebFrame(props: Readonly<{
    title: string;
    url: string;
    sandbox: PluginHostedWebSandboxPolicy;
    security: PluginHostedWebSecurityPolicyV1;
    testID: string;
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    bridge?: Readonly<{
        expectedOrigin: string;
        expectedPluginId: string;
        expectedContributionId: string;
        expectedSurfaceId: string;
        expectedNonce: string;
        expectedSessionId?: string | null;
        allowedMessageKinds: ReadonlySet<string>;
        onMessage: (
            envelope: PluginHostedWebBridgeEnvelopeV1,
        ) => void | PluginHostedWebBridgeResponseEnvelopeV1 | Promise<PluginHostedWebBridgeResponseEnvelopeV1 | void>;
    }> | null;
}>): React.ReactElement {
    return (
        <HostedPluginTarget
            title={props.title}
            url={props.url}
            sandbox={props.sandbox}
            security={props.security}
            testID={props.testID}
            navigationKey={props.navigationKey}
            navigationCommand={props.navigationCommand}
            diagnostics={props.diagnostics}
            bridge={props.bridge}
        />
    );
}
