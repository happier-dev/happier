import * as React from 'react';
import type { BrowserContextCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';

import type { BrowserShellContextState } from '@/components/browser/BrowserShell';
import {
    createBrowserContextState,
    disposeAllBrowserAnnotationDrafts,
    removeBrowserContextComposerAttachment,
    type BrowserAnnotationCaptureProvider,
    type BrowserContextState,
    type BrowserContextUnavailableReason,
} from '@/sync/domains/browser/context';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { commitBrowserAnnotation, type BrowserAnnotationCommitInput, type BrowserAnnotationCommitResult } from './commitBrowserAnnotation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

const SESSION_BROWSER_CONTEXT_CAPABILITIES = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference'],
    supportedAdapterKinds: [
        'localPreview',
        'hostedPlugin',
        'externalUrl',
        'chromiumSidecar',
        'streamedBrowserSurface',
    ],
    screenshot: {
        supported: false,
        requiresAttachmentUploads: true,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const SESSION_BROWSER_ANNOTATION_CONTEXT_CAPABILITIES = {
    ...SESSION_BROWSER_CONTEXT_CAPABILITIES,
    supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
    screenshot: {
        supported: true,
        requiresAttachmentUploads: true,
    },
} satisfies BrowserContextCapabilities;

export type SessionBrowserContextComposerContext = Readonly<{
    state: BrowserContextState;
    onAttachPageReference?: () => void;
    onRemoveAttachment: (attachmentId: string) => void;
    disabledReason?: string | null;
}>;

export type SessionBrowserContextRuntime = Readonly<{
    state: BrowserContextState;
    sessionTarget: ExactSessionMachineTargetIdentity | null;
    browserShellContext: BrowserShellContextState;
    composerContext: SessionBrowserContextComposerContext;
}>;

const SessionBrowserContextRuntimeContext = React.createContext<SessionBrowserContextRuntime | null>(null);

export function useSessionBrowserContextRuntime(params: Readonly<{
    enabled: boolean;
    scopeKey?: string | null;
    sessionId?: string | null;
    accountScope?: ServerAccountScope | null;
    attachmentsUploadsEnabled?: boolean;
    annotationCaptureProvider?: BrowserAnnotationCaptureProvider | null;
    annotationRuntimeActionExecute?: RuntimeActionExecute | null;
    nowMs?: () => number;
    onAttachUnavailable?: (reason: BrowserContextUnavailableReason) => void;
}>): SessionBrowserContextRuntime | null {
    const [state, setState] = React.useState(createBrowserContextState);
    const stateRef = React.useRef(state);
    const readState = React.useCallback(() => stateRef.current, []);
    const onStateChange = React.useCallback((next: BrowserContextState) => {
        // Keep live annotation admission current even before React publishes the next projection.
        stateRef.current = next;
        setState(next);
    }, []);
    const uploadConfig = useAttachmentsUploadConfig();
    const sessionTarget = React.useMemo(() => params.sessionId && params.accountScope
        ? { ...params.accountScope, sessionId: params.sessionId } : null,
    [params.sessionId, params.accountScope]);
    const commitAnnotation = React.useCallback((input: BrowserAnnotationCommitInput): Promise<BrowserAnnotationCommitResult> => sessionTarget
        ? commitBrowserAnnotation({ sessionTarget, config: uploadConfig }, input)
        : Promise.resolve({ ok: false, reason: 'annotation.targetUnavailable' }), [sessionTarget, uploadConfig]);
    const [attachPageReference, setAttachPageReference] = React.useState<(() => void) | null>(null);
    const annotationRuntimeActionExecute = React.useMemo(
        () => params.annotationRuntimeActionExecute ?? createFrontDoorRuntimeActionExecutor(),
        [params.annotationRuntimeActionExecute],
    );

    React.useEffect(() => {
        onStateChange(createBrowserContextState());
        setAttachPageReference(null);
        return () => disposeAllBrowserAnnotationDrafts(readState());
    }, [onStateChange, readState, params.scopeKey, params.sessionId, params.accountScope?.serverId, params.accountScope?.accountId]);

    const removeAttachment = React.useCallback((attachmentId: string) => {
        onStateChange(removeBrowserContextComposerAttachment(readState(), { attachmentId }));
    }, [onStateChange, readState]);

    const onAttachPageReferenceChange = React.useCallback((handler: (() => void) | null) => {
        setAttachPageReference(() => handler);
    }, []);

    return React.useMemo(() => {
        if (!params.enabled) return null;

        const annotationCaptureProvider = params.annotationCaptureProvider ?? null;
        // Annotation is always declared as a supported context kind (policy). The *runtime*
        // availability is decided at dispatch by the live capture provider (the BrowserShell host
        // builds the desktop native-snapshot producer where the engine supports it) plus the
        // per-kind reducer gate (adapter fidelity + screenshot support). Declaring the kind here
        // does not fake capture — a non-capable adapter still fails closed in the reducer.
        const contextCapabilities = SESSION_BROWSER_ANNOTATION_CONTEXT_CAPABILITIES;

        return {
            state,
            sessionTarget,
            browserShellContext: {
                state,
                accountScope: params.accountScope,
                readState,
                contextCapabilities,
                enabled: true,
                attachmentsUploadsEnabled: params.attachmentsUploadsEnabled,
                annotationCaptureProvider,
                commitAnnotation,
                annotationRuntimeActionExecute,
                nowMs: params.nowMs,
                onStateChange,
                onAttachPageReferenceChange,
                onAttachUnavailable: params.onAttachUnavailable,
            },
            composerContext: {
                state,
                onAttachPageReference: attachPageReference ?? undefined,
                onRemoveAttachment: removeAttachment,
                disabledReason: attachPageReference ? null : 'browser_context_view_unavailable',
            },
        };
    }, [
        attachPageReference,
        onAttachPageReferenceChange,
        onStateChange,
        readState,
        params.annotationCaptureProvider,
        params.accountScope,
        commitAnnotation,
        sessionTarget,
        annotationRuntimeActionExecute,
        params.attachmentsUploadsEnabled,
        params.enabled,
        params.nowMs,
        params.onAttachUnavailable,
        removeAttachment,
        state,
    ]);
}

export function SessionBrowserContextRuntimeProvider(props: Readonly<{
    runtime: SessionBrowserContextRuntime | null;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <SessionBrowserContextRuntimeContext.Provider value={props.runtime}>
            {props.children}
        </SessionBrowserContextRuntimeContext.Provider>
    );
}

export function useSessionBrowserContextRuntimeContext(): SessionBrowserContextRuntime | null {
    return React.useContext(SessionBrowserContextRuntimeContext);
}
