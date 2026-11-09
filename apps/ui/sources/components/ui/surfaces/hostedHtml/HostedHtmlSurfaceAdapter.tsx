import * as React from 'react';
import { View } from 'react-native';
import type { PluginSurfaceTarget, SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import type {
    PluginHostedWebSecurityPolicyV1,
    PluginUiHostMethodV1,
    PluginUiJsonValueV1,
    PluginUiLaunchInputV1,
    PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createCallerHostedHtmlHostApiBridgeHandler,
    type CallerHostedHtmlHostApiRequest,
} from '@/components/plugins/hostApi/hostedWebAdapter';
import type { SessionCallerHostedHtmlRequestController } from './sessionCallerHostedHtmlRequestController';
import { useUiSurfaceRendererMount } from '@/components/plugins/hostApi/useUiSurfaceRendererMount';
import { HostedFrameHost } from '@/components/ui/surfaces/framed/HostedFrameHost';
import { UiSurfaceRendererHost } from '@/components/ui/surfaces/UiSurfaceRendererHost';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { BrowserFrameLoading } from '@/components/browser/frame/BrowserFrameLoading';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { HostedInlineDocumentFrameUnavailableCode } from '@/components/plugins/hostedWeb/hostedInlineDocumentFrameTypes';
import { createHostedFrameIntrinsicHeightReporter } from '@/components/plugins/hostApi/hostedFrameIntrinsicHeight';
import { createUiSurfaceMountIdentity } from '@/components/plugins/hostApi/createUiSurfaceMountIdentity';
import { useHostedFrameLifecycle } from '@/components/ui/surfaces/framed/useHostedFrameLifecycle';
import {
    createPluginSurfaceContext,
    getPluginSurfaceTargetMountKey,
    usePluginSurfaceEnvironment,
} from '@/components/plugins/surfaces/pluginSurfaceContext';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { useLayoutPresentationActive, usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import {
    prepareCallerHostedHtmlSurface,
    type PreparedCallerHostedHtmlSurface,
} from './prepareCallerHostedHtmlSurface';

const CALLER_FRAME_MESSAGES = new Set(['ready', 'error', 'heightChanged', 'hostApi', 'openExternal']);
const openCallerExternalLink = async (url: string): Promise<void> => { await openExternalUrl(url); };
const CALLER_SURFACE_STYLE = Object.freeze({ flex: 1, minHeight: 0 });
const CALLER_MOUNT = Object.freeze({ kind: 'embedded' as const, role: 'callerHostedHtml', presentation: 'content' as const });
const CALLER_TRANSLATIONS = Object.freeze({});
const CALLER_SANDBOX = Object.freeze({
    scripts: true,
    sameOrigin: false,
    popups: false,
    topNavigation: false,
    mixedContent: false,
});

function isJsonRecord(
    value: PluginUiJsonValueV1 | undefined,
): value is Readonly<Record<string, PluginUiJsonValueV1>> {
    return value !== null
        && value !== undefined
        && typeof value === 'object'
        && !Array.isArray(value);
}
export type CallerHostedHtmlRuntime = Readonly<{
    serverIdentityId: string;
    accountId: string;
    accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
    hostOrigin: string;
    admittedHostMethods: readonly PluginUiHostMethodV1[];
    createRequestController: (
        publishResourceEvent: (event: PluginUiResourceSubscriptionEventV1) => void,
        mount?: Readonly<{ mountInstanceKey: string; input?: PluginUiLaunchInputV1; target?: PluginSurfaceTarget }>,
    ) => SessionCallerHostedHtmlRequestController;
    lifetime: Readonly<{
        isCurrent: () => boolean;
        onRetire: (listener: () => void) => Readonly<{ dispose: () => void }>;
    }>;
}>;

/**
 * Session-authored HTML's thin authority adapter around the incumbent frame.
 * The outer Session record supplies revision/currentness and admitted policy; the
 * shared bridge supplies transport, negotiation, subscriptions and teardown.
 */
export function HostedHtmlSurfaceAdapter(props: Readonly<{
    sessionId?: string;
    title: string;
    recordRevision: string;
    approvalSubject: string;
    source: unknown;
    requestedCapabilities?: unknown;
    input?: PluginUiLaunchInputV1;
    target: PluginSurfaceTarget;
    runtime: CallerHostedHtmlRuntime;
    onIntrinsicHeightChange?: (height: number) => void;
    testID: string;
}>): React.ReactElement | null {
    const presentationActive = useLayoutPresentationActive();
    const focusEligible = usePluginSurfaceFocusEligibility();
    const activityRef = React.useRef({ active: presentationActive });
    activityRef.current = { active: presentationActive };
    const launchInputKey = stableJsonStringify(props.input);
    // Launch input belongs to the physical mount. Equivalent parent snapshots must
    // not dispose its request controller or disconnect the still-running frame.
    const launchInput = React.useMemo(() => props.input, [launchInputKey]);
    const targetKey = stableJsonStringify(props.target);
    // This transport boundary retains an equal accepted disclosure separately
    // from physical identity, so Resource updates never replace the document.
    const target = React.useMemo(() => props.target, [targetKey]);
    const logicalMountKey = stableJsonStringify({
        serverIdentityId: props.runtime.serverIdentityId,
        accountId: props.runtime.accountId,
        sessionId: props.sessionId,
        target: getPluginSurfaceTargetMountKey(target),
        accountEncryptionMode: props.runtime.accountEncryptionMode,
        approvalSubject: props.approvalSubject,
        recordRevision: props.recordRevision,
        source: props.source,
        requestedCapabilities: props.requestedCapabilities,
        input: launchInput,
    });
    const logicalInstanceId = React.useMemo(
        () => createUiSurfaceMountIdentity()?.instanceId ?? null,
        [logicalMountKey],
    );
    const frameSink = React.useRef<((message: unknown) => void) | null>(null);
    const bridgeRef = React.useRef<ReturnType<typeof createCallerHostedHtmlHostApiBridgeHandler> | null>(null);
    const lifecycle = useHostedFrameLifecycle({
        lifetimeKey: logicalMountKey,
        onRetireAttempt: () => {
            frameSink.current = null;
            bridgeRef.current?.dispose();
        },
    });
    const mount = useUiSurfaceRendererMount({
        lifetime: props.runtime.lifetime,
        mountKey: `${logicalMountKey}\u001f${lifecycle.attempt}`,
        instanceId: logicalInstanceId,
        interactionEnabled: presentationActive,
        focusEligible,
    });
    const frameIdentity = mount.identity;
    const [frameUnavailable, setFrameUnavailable] = React.useState<HostedInlineDocumentFrameUnavailableCode | null>(null);
    React.useLayoutEffect(() => {
        setFrameUnavailable(null);
    }, [mount.identity]);
    const handleFrameUnavailable = React.useCallback((code: HostedInlineDocumentFrameUnavailableCode) => {
        if (code === 'native_inline_document_load_failed') {
            lifecycle.fail('load_failed');
            return;
        }
        setFrameUnavailable(code);
    }, [lifecycle.fail]);
    const admittedHostMethodsKey = stableJsonStringify(props.runtime.admittedHostMethods);
    // Record projections can allocate equal JSON again on presentation updates. Admission follows
    // the same canonical source/policy identity as the physical mount, not those object references;
    // otherwise a still-current frame briefly becomes loading and loses its document.
    const preparation = React.useMemo(() => frameIdentity === null
        ? null
        : {
            source: props.source,
            requestedCapabilities: props.requestedCapabilities,
            admittedHostMethods: props.runtime.admittedHostMethods,
        }, [frameIdentity, logicalMountKey, admittedHostMethodsKey, props.runtime.hostOrigin]);
    const [preparedResult, setPreparedResult] = React.useState<Readonly<{
        input: NonNullable<typeof preparation>;
        value: PreparedCallerHostedHtmlSurface;
    }> | null>(null);
    React.useEffect(() => {
        if (preparation === null) return;
        let current = true;
        void prepareCallerHostedHtmlSurface(preparation).then(value => {
            if (current && mount.isCurrent()) setPreparedResult({ input: preparation, value });
        }).catch(() => {
            if (current && mount.isCurrent()) setPreparedResult({ input: preparation, value: { kind: 'rejected', code: 'source_invalid' } });
        });
        return () => { current = false; };
    }, [preparation, mount.isCurrent]);
    const prepared = preparedResult?.input === preparation ? preparedResult.value : null;
    const reportHeight = React.useRef(props.onIntrinsicHeightChange);
    reportHeight.current = props.onIntrinsicHeightChange;
    const heightReporter = React.useMemo(() => createHostedFrameIntrinsicHeightReporter({
        publish: (height) => reportHeight.current?.(height),
        scheduleFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
    }), [mount.identity]);
    React.useLayoutEffect(() => () => heightReporter.dispose(), [heightReporter]);
    React.useLayoutEffect(() => {
        // The physical document can outlive its presenter. A replacement needs
        // its published room even when the guest's dimensions have not changed.
        const height = heightReporter.readPublishedHeight();
        if (height !== null && mount.isCurrent()) props.onIntrinsicHeightChange?.(height);
    }, [heightReporter, mount.isCurrent, props.onIntrinsicHeightChange]);
    const createRequestController = props.runtime.createRequestController;
    const requestController = React.useMemo(
        () => frameIdentity === null
            ? null
            : createRequestController(
                (event) => { bridgeRef.current?.publishResourceSubscriptionEvent(event); },
                { mountInstanceKey: frameIdentity.instanceId, input: launchInput, target },
            ),
        [createRequestController, frameIdentity, launchInput],
    );
    React.useLayoutEffect(() => { requestController?.updateSurfaceTarget?.(target); }, [requestController, target]);
    const authorizeRequest = React.useCallback((request: CallerHostedHtmlHostApiRequest): boolean => {
        if (prepared?.kind !== 'admitted') return false;
        if (request.method !== 'readResource'
            && request.method !== 'watchResource'
            && request.method !== 'executeAction') return true;
        if (!isJsonRecord(request.payload)) return false;
        const reference = request.method === 'executeAction'
            ? request.payload.action
            : request.payload.resource;
        if (reference === undefined) return false;
        const admitted = request.method === 'executeAction'
            ? prepared.capabilityManifest.requested.actions
            : prepared.capabilityManifest.requested.resources;
        const referenceKey = stableJsonStringify(reference);
        return admitted.some((candidate) => stableJsonStringify(candidate) === referenceKey);
    }, [prepared]);
    // The bridge belongs to the physical mount and its authority, not to the identity of the
    // context object. Context changes travel through the bridge's own `pushSurfaceContext`,
    // which already suppresses semantically identical snapshots; rebuilding the bridge instead
    // disposed it, and `dispose` tells a still-running frame it was `disconnected`.
    const environment = usePluginSurfaceEnvironment(resolveLocalServicePreviewPlatform());
    const surfaceSnapshot = React.useMemo(() => (
        prepared?.kind === 'admitted'
            ? createPluginSurfaceContext({
                mount: CALLER_MOUNT,
                target,
                accountEncryptionMode: props.runtime.accountEncryptionMode,
                environment,
                translations: CALLER_TRANSLATIONS,
            })
            : null
    ), [environment, prepared, target, props.runtime.accountEncryptionMode]);
    // Read at bridge construction so the first negotiation already carries the current
    // environment (before reveal); later changes are pushed, never a new bridge.
    const surfaceSnapshotRef = React.useRef(surfaceSnapshot);
    surfaceSnapshotRef.current = surfaceSnapshot;
    const bridge = React.useMemo(() => {
        if (frameIdentity === null || requestController === null || prepared?.kind !== 'admitted' || surfaceSnapshotRef.current === null) return null;
        return createCallerHostedHtmlHostApiBridgeHandler({
            callerAuthority: {
                kind: 'callerHostedHtml',
                ...(props.sessionId ? { sessionId: props.sessionId } : {}),
                recordRevision: props.recordRevision,
            },
            requestIdPrefix: `session-html:${props.sessionId}:${props.recordRevision}`,
            identity: frameIdentity,
            handleRequest: requestController.handleRequest,
            authorizeRequest,
            canonicalHostApi: {
                identity: frameIdentity,
                surface: surfaceSnapshotRef.current,
                methods: prepared.advertisedHostMethods,
                activity: activityRef.current,
            },
            readInstalledMethods: () => prepared.advertisedHostMethods,
            postToFrame: (message) => frameSink.current?.(message),
            bootstrap: {
                frameOrigin: 'null',
                ...(launchInput === undefined ? {} : { launchInput }),
            },
            isCurrent: mount.isCurrent,
            onReadyStateChange: (state) => {
                if (state.state === 'ready') lifecycle.markReady();
            },
            onGuestError: () => lifecycle.fail('guest_error'),
            onOpenExternal: openCallerExternalLink,
            ...(props.onIntrinsicHeightChange ? { onHeightChanged: heightReporter.report } : {}),
        });
    }, [authorizeRequest, frameIdentity, heightReporter, lifecycle.fail, lifecycle.markReady, mount.isCurrent, prepared, launchInput, props.recordRevision,
        props.sessionId, requestController?.handleRequest]);
    React.useEffect(() => {
        bridgeRef.current = bridge;
        return () => {
            if (bridgeRef.current === bridge) bridgeRef.current = null;
            bridge?.dispose();
        };
    }, [bridge]);
    React.useEffect(() => {
        // The whole surface snapshot, exactly as the bridge was constructed with it: this is the
        // mount's context producer, and `pushSurfaceContext` republishes nothing when the
        // snapshot is semantically identical.
        if (surfaceSnapshot !== null) bridge?.pushSurfaceContext(surfaceSnapshot, { active: presentationActive });
    }, [bridge, surfaceSnapshot, presentationActive]);
    React.useEffect(() => () => requestController?.dispose(), [requestController]);
    if (frameIdentity === null) {
        return (
            <SurfaceStateCard
                testID={`${props.testID}-unavailable`}
                kind="unavailable"
                title={t('sessionBoard.item.rendererUnavailable.title')}
                reason={t('sessionBoard.item.rendererUnavailable.reason')}
                diagnosticCode="hosted_web_profile_isolation_unavailable"
                accessibilitySemantics="status"
            />
        );
    }
    if (prepared === null) return <BrowserFrameLoading testID={props.testID} host={props.title} />;
    if (prepared.kind !== 'admitted') {
        return (
            <SurfaceStateCard
                testID={`${props.testID}-unavailable`}
                kind="unavailable"
                title={t('sessionBoard.item.rendererUnavailable.title')}
                reason={t('sessionBoard.item.rendererUnavailable.reason')}
                diagnosticCode={prepared.code}
                accessibilitySemantics="status"
            />
        );
    }
    if (frameUnavailable) {
        return (
            <SurfaceStateCard
                testID={`${props.testID}-unavailable`}
                kind="unavailable"
                title={t('sessionBoard.item.rendererUnavailable.title')}
                reason={t('sessionBoard.item.rendererUnavailable.reason')}
                diagnosticCode={frameUnavailable}
                accessibilitySemantics="status"
            />
        );
    }
    if (lifecycle.failure) {
        return (
            <SurfaceStateCard
                testID={`${props.testID}-error`}
                kind="error"
                title={t('browserShell.frame.errorTitle')}
                diagnosticCode={`hosted_frame_${lifecycle.failure}`}
                action={{ label: t('browserShell.toolbar.reloadAfterCrash'), onPress: lifecycle.reload }}
                accessibilitySemantics="alert"
            />
        );
    }
    if (!bridge) return null;

    const hostedHtmlRenderer = () => (
        <View style={CALLER_SURFACE_STYLE}>
          <HostedFrameHost
            title={props.title}
            bundle={prepared.frameSource.bundle}
            network={prepared.frameSource.network}
            networkOrigins={prepared.frameSource.networkOrigins}
            externalHttpLinks
            bootstrapConfig={{
                identity: frameIdentity,
                frameOrigin: 'null',
                hostOrigin: props.runtime.hostOrigin,
            }}
            sandbox={CALLER_SANDBOX}
            security={{
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [...prepared.frameSource.networkOrigins],
                csp: {
                    connectSrc: prepared.frameSource.networkOrigins.length > 0 ? 'declaredOrigins' : 'none',
                    allowDataUrls: true,
                    allowBlobUrls: false,
                    allowInlineStyles: true,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'deny',
            } satisfies PluginHostedWebSecurityPolicyV1}
            testID={props.testID}
            onNativeHostedHtmlUnavailable={handleFrameUnavailable}
            onLoad={lifecycle.markLoaded}
            onError={() => lifecycle.fail('load_failed')}
            onUnexpectedNavigation={() => lifecycle.fail('unexpected_navigation')}
            bridge={{
                expectedOrigin: 'null',
                identity: frameIdentity,
                allowedMessageKinds: CALLER_FRAME_MESSAGES,
                attachHostMessages: (send) => {
                    frameSink.current = send;
                    return () => { if (frameSink.current === send) frameSink.current = null; };
                },
                onMessage: bridge,
            }}
          />
        </View>
    );
    return (
        <UiSurfaceRendererHost
            kind="hostedHtml"
            renderers={{
                declarative: () => null,
                hostedHtml: hostedHtmlRenderer,
                hostedWeb: () => null,
                reactNative: () => null,
            }}
        />
    );
}
