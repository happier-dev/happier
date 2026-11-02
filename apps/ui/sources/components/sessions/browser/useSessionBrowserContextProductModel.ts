import * as React from 'react';
import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';

import { createManagedChromiumBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context';
import { useBrowserDaemonControlTransport } from '@/sync/domains/browser/control';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { getStorage } from '@/sync/domains/state/storage';

import { useSessionBrowserContextRuntimeContext } from './sessionBrowserContextRuntime';

/**
 * The session's browser-context model as every session browser host hands it to the shell: the
 * session runtime's context, with the managed-Chromium annotation capture provider bound to the
 * session's machine. One owner, so the Details tab, the phone Browser tab and the right panel can
 * never disagree about whether marking up the agent's browser works.
 */
export function useSessionBrowserContextProductModel(input: Readonly<{
    machineId: string | null | undefined;
    serverId: string | null | undefined;
}>) {
    const runtime = useSessionBrowserContextRuntimeContext();
    const machineId = input.machineId ?? null;
    const serverId = input.serverId ?? null;
    const previewScope = useSessionWorkspaceTarget(runtime?.sessionTarget?.sessionId, runtime?.sessionTarget?.serverId);
    const machineHappyHomeDir = getStorage()(state => machineId && serverId
        ? state.machineListByServerId?.[serverId]?.find(machine => machine.id === machineId)?.metadata?.happyHomeDir ?? null
        : null);
    const sendCommand = useBrowserDaemonControlTransport({ machineId, serverId });
    const daemonControl = React.useMemo(() => {
        if (!sendCommand) return undefined;
        // One host subscriber per session product model, not another browser state owner.
        let listener: ((event: BrowserEventV1) => void) | null = null;
        const receiveBrowserEvent = (event: BrowserEventV1) => listener?.(event);
        return {
            sendCommand: (command: Parameters<typeof sendCommand>[0]) => sendCommand(command, events => events.forEach(receiveBrowserEvent)),
            receiveBrowserEvent,
            subscribeBrowserEvents: (next: (event: BrowserEventV1) => void) => {
                listener = next;
                return () => { if (listener === next) listener = null; };
            },
        };
    }, [sendCommand]);
    // Capturing another item reconstructs the map without navigating. Keep that
    // publication from cancelling other captures still using the same page.
    const navigation = JSON.stringify(runtime?.state.navigationGenerationByViewId ?? {});
    const captureBinding = React.useMemo(() => {
        if (!machineId) return null;
        const lifetime = { controller: new AbortController() };
        return { lifetime, provider: createManagedChromiumBrowserAnnotationCaptureProvider({ machineId, serverId, previewScope, machineHappyHomeDir,
            get signal() { return lifetime.controller.signal; } }) };
    }, [machineId, serverId, navigation, previewScope, machineHappyHomeDir]);
    React.useEffect(() => {
        if (!captureBinding) return;
        if (captureBinding.lifetime.controller.signal.aborted) captureBinding.lifetime.controller = new AbortController();
        return () => captureBinding.lifetime.controller.abort();
    }, [captureBinding]);
    const provider = captureBinding?.provider;
    const shellContext = runtime?.browserShellContext;
    return React.useMemo(() => {
        if (!shellContext) return shellContext;
        return { ...shellContext, daemonControl,
            ...(provider ? { annotationCaptureProvider: provider, managedAnnotationCaptureProvider: true } : {}) };
    }, [daemonControl, provider, shellContext]);
}
