import * as React from 'react';

import { t } from '@/text';

import { BrowserStreamedConnecting, type BrowserStreamedSurfaceRuntime } from '../adapters/BrowserStreamedTarget';
import { useBrowserSessionAgentIdentity, type BrowserShellAgentPresence } from '../copresence/BrowserShellPresence';

/**
 * The agent's first open while no view exists yet: the Machine is preparing its browser, or the open
 * went through and the page is on its way. Both are the Connecting state of the streamed surface, so
 * the page comes up in one presentation: preparing, then connecting, then the first frame.
 */
export function BrowserFirstUseConnecting(props: Readonly<{
    firstUse: 'preparing' | 'opening';
    machineName: BrowserStreamedSurfaceRuntime['machineName'];
    agent: BrowserShellAgentPresence | null;
    testID: string;
}>): React.ReactElement {
    const identity = useBrowserSessionAgentIdentity(props.agent);
    const preparing = props.firstUse === 'preparing';
    return (
        <BrowserStreamedConnecting
            testID={props.testID}
            title={preparing
                ? t('browserPresence.stream.preparingTitle')
                : identity.agentless ? t('browserPresence.stream.connectingTitleAgentless') : t('browserPresence.stream.connectingTitle', { agent: identity.name })}
            reason={preparing
                ? t('browserPresence.stream.preparingBody')
                : props.machineName ? t('browserPresence.stream.connectingBody', { machine: props.machineName }) : undefined}
        />
    );
}
