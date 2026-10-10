import * as React from 'react';
import type { EmbeddedTerminalPaneController } from './types';
import type { EmbeddedTerminalRendererHandle } from './embeddedTerminalRendererHandle';
import { publishTerminalSurfaceSummary } from '@/components/sessions/terminal/terminalSurfaceSummary';
import { createSessionTerminalLeafHandles } from '@/components/sessions/terminal/strip/sessionTerminalLeafHandles';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

/** Mounted renderer presentation shared by Session and Project hosts; no process authority. */
export function useEmbeddedTerminalPresentation(input: Readonly<{
    scopeId: string; terminalKey: string; terminalId: string | null; available: boolean; focused?: boolean;
    controller: EmbeddedTerminalPaneController;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
}>) {
    const { controller, terminalKey } = input;
    const router = useRouter();
    const onOpenApproval = React.useMemo(() => controller.approvalId && controller.approvalServerId
        ? () => router.push(`/inbox/approvals/${encodeURIComponent(controller.approvalId!)}?serverId=${encodeURIComponent(controller.approvalServerId!)}`)
        : undefined, [controller.approvalId, controller.approvalServerId, router]);
    const seenBell = React.useRef(controller.terminalBell ?? null);
    if (input.focused) seenBell.current = controller.terminalBell ?? null;
    const unseenBell = controller.terminalBell && controller.terminalBell !== seenBell.current ? controller.terminalBell : null;
    const url = controller.detectedUrl?.url ?? null;
    React.useEffect(() => publishTerminalSurfaceSummary(terminalKey, {
        title: controller.terminalTitle ?? null, bell: unseenBell, status: controller.status,
        error: controller.status === 'error' ? controller.error : null, url,
    }), [controller.error, controller.status, controller.terminalTitle, terminalKey, unseenBell, url]);
    const handles = React.useMemo(() => createSessionTerminalLeafHandles(input.scopeId), [input.scopeId]);
    const findRuntime = useFindSurfaceRuntime();
    const mountedId = React.useId();
    const findSurfaceId = `terminal:${terminalKey}:${mountedId}`;
    const findEligible = usePluginSurfaceFocusEligibility() && input.focused !== false;
    const { clearTerminal, requestRestart, copySelection, onPaste } = controller;
    React.useEffect(() => {
        if (!input.terminalId || !input.available) return;
        return handles.register(input.terminalId, {
            get find() { return findEligible && input.terminalRef.current?.find ? () => findRuntime.open(findSurfaceId) : null; },
            copySelection: copySelection ? () => copySelection() : null,
            paste: () => { void getClipboardStringTrimmedSafe().then(text => { if (text) void onPaste(text); }); },
            clear: clearTerminal, restart: requestRestart,
        });
    }, [clearTerminal, copySelection, findEligible, findRuntime, findSurfaceId, handles, input.available,
        input.terminalId, input.terminalRef, onPaste, requestRestart]);
    return { findSurfaceId, findEligible, onOpenApproval };
}
