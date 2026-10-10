import * as React from 'react';
import { View } from 'react-native';

import { formatUiSurfaceActionRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type {
    PluginHostedWebSecurityPolicyV1,
    PluginUiHostMethodV1,
    PluginUiJsonValueV1,
    PluginUiLaunchInputV1,
    PluginUiResourceSubscriptionEventV1,
    UiSurfaceExecutableApprovalKeyV1,
    NormalizedUiSurfaceCapabilityRequestV1,
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
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { HostedInlineDocumentFrameUnavailableCode } from '@/components/plugins/hostedWeb/hostedInlineDocumentFrameTypes';
import { createHostedFrameIntrinsicHeightReporter } from '@/components/plugins/hostApi/hostedFrameIntrinsicHeight';
import { createUiSurfaceMountIdentity } from '@/components/plugins/hostApi/createUiSurfaceMountIdentity';
import { useHostedFrameLifecycle } from '@/components/ui/surfaces/framed/useHostedFrameLifecycle';
import {
    usePluginSurfaceEnvironment,
    type PluginSurfaceEnvironment,
} from '@/components/plugins/surfaces/pluginSurfaceContext';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';

import {
    prepareCallerHostedHtmlSurface,
    type PreparedCallerHostedHtmlSurface,
} from './prepareCallerHostedHtmlSurface';

const CALLER_FRAME_MESSAGES = new Set(['ready', 'error', 'heightChanged', 'hostApi']);
/**
 * Posting into the person's own conversation is the one requested Action people
 * reason about by name, so the review says it in words instead of counting it
 * with the rest.
 */
const SESSION_MESSAGE_SEND_ACTION_ID = 'session.message.send';
const CALLER_SURFACE_STYLE = Object.freeze({ flex: 1, minHeight: 0 });
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
    hostOrigin: string;
    admittedHostMethods: readonly PluginUiHostMethodV1[];
    isApproved: (approval: UiSurfaceExecutableApprovalKeyV1, approvalKey: string, capabilities: NormalizedUiSurfaceCapabilityRequestV1) => boolean;
    approve: (approval: UiSurfaceExecutableApprovalKeyV1, approvalKey: string, capabilities: NormalizedUiSurfaceCapabilityRequestV1) => void;
    revoke: (approval: UiSurfaceExecutableApprovalKeyV1, approvalKey: string) => void;
    createRequestController: (
        publishResourceEvent: (event: PluginUiResourceSubscriptionEventV1) => void,
    ) => SessionCallerHostedHtmlRequestController;
    lifetime: Readonly<{
        isCurrent: () => boolean;
        onRetire: (listener: () => void) => Readonly<{ dispose: () => void }>;
    }>;
}>;

/**
 * Session-authored HTML's thin authority adapter around the incumbent frame.
 * The outer Session record supplies revision/currentness and approval; the
 * shared bridge supplies transport, negotiation, subscriptions and teardown.
 */
/**
 * The mount's surface snapshot — one shape for the value the bridge is constructed with and the
 * value its context producer republishes, so a later push can never narrow what `context`
 * already answered.
 */
function buildCallerHostedHtmlSurfaceSnapshot(input: Readonly<{
    context: PluginUiJsonValueV1;
    recordRevision: string;
    capabilityManifest: Extract<PreparedCallerHostedHtmlSurface, { kind: 'admitted' }>['capabilityManifest'];
    environment: PluginSurfaceEnvironment;
}>) {
    // The same environment facts, under the same names, that every installed surface's
    // `SurfaceContext` carries from the one shared producer. An opaque isolated document
    // cannot read the host's theme, text scale, direction or safe area itself.
    return {
        platform: input.environment.platform,
        locale: input.environment.locale,
        direction: input.environment.direction,
        colorScheme: input.environment.colorScheme,
        contrast: input.environment.contrast,
        textScale: input.environment.textScale,
        reducedMotion: input.environment.reducedMotion,
        screenReaderEnabled: input.environment.screenReaderEnabled,
        safeAreaInsets: input.environment.safeAreaInsets,
        theme: input.environment.theme,
        context: input.context,
        callerHostedHtml: {
            recordRevision: input.recordRevision,
            capabilityManifest: input.capabilityManifest,
        },
    };
}

export function HostedHtmlSurfaceAdapter(props: Readonly<{
    sessionId: string;
    title: string;
    recordRevision: string;
    approvalSubject: string;
    source: unknown;
    requestedCapabilities?: unknown;
    input?: PluginUiLaunchInputV1;
    surfaceContext: PluginUiJsonValueV1;
    runtime: CallerHostedHtmlRuntime;
    onIntrinsicHeightChange?: (height: number) => void;
    testID: string;
}>): React.ReactElement | null {
    const logicalMountKey = stableJsonStringify({
        serverIdentityId: props.runtime.serverIdentityId,
        accountId: props.runtime.accountId,
        sessionId: props.sessionId,
        approvalSubject: props.approvalSubject,
        recordRevision: props.recordRevision,
        source: props.source,
        requestedCapabilities: props.requestedCapabilities,
    });
    const logicalInstanceId = React.useMemo(
        () => createUiSurfaceMountIdentity()?.instanceId ?? null,
        [logicalMountKey],
    );
    const frameSink = React.useRef<((message: unknown) => void) | null>(null);
    const bridgeRef = React.useRef<ReturnType<typeof createCallerHostedHtmlHostApiBridgeHandler> | null>(null);
    const lifecycle = useHostedFrameLifecycle({
        lifetimeKey: logicalMountKey,
        readyRequired: true,
        onReadyTimeout: () => { bridgeRef.current?.recordReadyTimeout(); },
        onRetireAttempt: () => {
            frameSink.current = null;
            bridgeRef.current?.dispose();
        },
    });
    const mount = useUiSurfaceRendererMount({
        lifetime: props.runtime.lifetime,
        mountKey: `${logicalMountKey}\u001f${lifecycle.attempt}`,
        instanceId: logicalInstanceId,
        interactionEnabled: true,
        focusEligible: true,
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
    const prepared = React.useMemo(() => frameIdentity === null
        ? null
        : prepareCallerHostedHtmlSurface({
            serverIdentityId: props.runtime.serverIdentityId,
            accountId: props.runtime.accountId,
            approvalSubject: props.approvalSubject,
            source: props.source,
            requestedCapabilities: props.requestedCapabilities,
            admittedHostMethods: props.runtime.admittedHostMethods,
            frameIdentity,
            hostOrigin: props.runtime.hostOrigin,
        }), [frameIdentity, props.approvalSubject, props.requestedCapabilities, props.runtime.accountId,
        props.runtime.admittedHostMethods, props.runtime.hostOrigin, props.runtime.serverIdentityId, props.source]);
    const requiresApproval = prepared?.kind === 'admitted'
        && (prepared.capabilityManifest.requested.hostMethods.length > 0
            || prepared.capabilityManifest.requested.resources.length > 0
            || prepared.capabilityManifest.requested.actions.length > 0
            || prepared.capabilityManifest.requested.networkOrigins.length > 0);
    const approved = prepared?.kind === 'admitted'
        && (!requiresApproval || props.runtime.isApproved(prepared.approval, prepared.approvalKey, prepared.capabilityManifest.requested));
    // "Not now" is a local dismissal, not a recorded refusal: nothing is
    // written, and a different request (a new approval key) is a new review.
    const approvalKey = prepared?.kind === 'admitted' ? prepared.approvalKey : null;
    const [reviewDeclined, setReviewDeclined] = React.useState(false);
    React.useLayoutEffect(() => { setReviewDeclined(false); }, [approvalKey]);
    // What the view asked for, said in this person's language. The exact
    // manifest, fingerprint and revision stay on the card's diagnostics channel.
    const capabilityReviewRows = React.useMemo((): readonly string[] => {
        if (prepared?.kind !== 'admitted') return [];
        const requested = prepared.capabilityManifest.requested;
        const actionIds = requested.actions.map(formatUiSurfaceActionRequestV1);
        const canSendMessages = actionIds.includes(SESSION_MESSAGE_SEND_ACTION_ID);
        const otherActionCount = actionIds.length - (canSendMessages ? 1 : 0);
        return [
            ...(requested.resources.length > 0
                ? [t('sessionBoard.hostedHtmlApproval.resources', { count: requested.resources.length })]
                : []),
            ...(otherActionCount > 0
                ? [t('sessionBoard.hostedHtmlApproval.actions', { count: otherActionCount })]
                : []),
            ...(canSendMessages ? [t('sessionBoard.hostedHtmlApproval.sendMessages')] : []),
            ...requested.networkOrigins.map(
                (origin) => t('sessionBoard.hostedHtmlApproval.loadsFrom', { origin }),
            ),
        ];
    }, [prepared]);
    const heightReporter = React.useMemo(() => createHostedFrameIntrinsicHeightReporter({
        publish: (height) => props.onIntrinsicHeightChange?.(height),
        scheduleFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
    }), [mount.identity, props.onIntrinsicHeightChange]);
    React.useLayoutEffect(() => () => heightReporter.dispose(), [heightReporter]);
    // Keyed on the request owner, not the runtime value: a runtime re-published
    // only because some other item's approval changed keeps this mount's watches.
    const createRequestController = props.runtime.createRequestController;
    const requestController = React.useMemo(
        () => frameIdentity === null
            ? null
            : createRequestController(
                (event) => { bridgeRef.current?.publishResourceSubscriptionEvent(event); },
            ),
        [createRequestController, frameIdentity],
    );
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
            ? buildCallerHostedHtmlSurfaceSnapshot({
                context: props.surfaceContext,
                recordRevision: props.recordRevision,
                capabilityManifest: prepared.capabilityManifest,
                environment,
            })
            : null
    ), [environment, prepared, props.recordRevision, props.surfaceContext]);
    const surfaceContextRef = React.useRef(props.surfaceContext);
    surfaceContextRef.current = props.surfaceContext;
    // Read at bridge construction so the first negotiation already carries the current
    // environment (before reveal); later changes are pushed, never a new bridge.
    const environmentRef = React.useRef(environment);
    environmentRef.current = environment;
    const bridge = React.useMemo(() => {
        if (frameIdentity === null || requestController === null || prepared?.kind !== 'admitted' || !approved) return null;
        return createCallerHostedHtmlHostApiBridgeHandler({
            callerAuthority: {
                kind: 'callerHostedHtml',
                sessionId: props.sessionId,
                recordRevision: props.recordRevision,
            },
            requestIdPrefix: `session-html:${props.sessionId}:${props.recordRevision}`,
            identity: frameIdentity,
            handleRequest: requestController.handleRequest,
            authorizeRequest,
            canonicalHostApi: {
                identity: frameIdentity,
                surface: buildCallerHostedHtmlSurfaceSnapshot({
                    context: surfaceContextRef.current,
                    recordRevision: props.recordRevision,
                    capabilityManifest: prepared.capabilityManifest,
                    environment: environmentRef.current,
                }),
                methods: prepared.advertisedHostMethods,
                activity: { active: true },
            },
            readInstalledMethods: () => prepared.advertisedHostMethods,
            postToFrame: (message) => frameSink.current?.(message),
            bootstrap: {
                frameOrigin: 'null',
                ...(props.input === undefined ? {} : { launchInput: props.input }),
            },
            isCurrent: mount.isCurrent,
            onReadyStateChange: (state) => {
                if (state.state === 'ready') lifecycle.markReady();
            },
            onGuestError: () => lifecycle.fail('guest_error'),
            ...(props.onIntrinsicHeightChange ? { onHeightChanged: heightReporter.report } : {}),
        });
    }, [approved, authorizeRequest, frameIdentity, heightReporter, lifecycle.fail, lifecycle.markReady, mount.isCurrent, prepared, props.input, props.recordRevision,
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
        if (surfaceSnapshot !== null) bridge?.pushSurfaceContext(surfaceSnapshot);
    }, [bridge, surfaceSnapshot]);
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
    if (prepared === null) return null;
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
    if (!approved) {
        if (reviewDeclined) {
            return (
                <SurfaceStateCard
                    testID={`${props.testID}-declined`}
                    kind="unavailable"
                    title={t('sessionBoard.hostedHtmlApproval.declined.title')}
                    reason={t('sessionBoard.hostedHtmlApproval.declined.reason')}
                    action={{
                        label: t('sessionBoard.hostedHtmlApproval.declined.review'),
                        onPress: () => setReviewDeclined(false),
                    }}
                    accessibilitySemantics="status"
                />
            );
        }
        return (
            <SurfaceStateCard
                testID={`${props.testID}-approval`}
                kind="warning"
                title={t('sessionBoard.hostedHtmlApproval.title')}
                reason={capabilityReviewRows.join('\n')}
                detail={t('sessionBoard.hostedHtmlApproval.body')}
                diagnosticCode={`${props.recordRevision}:${prepared.approval.executableSecurityFingerprint}`}
                action={{
                    label: t('sessionBoard.hostedHtmlApproval.allow'),
                    onPress: () => props.runtime.approve(prepared.approval, prepared.approvalKey, prepared.capabilityManifest.requested),
                }}
                secondaryAction={{
                    label: t('sessionBoard.hostedHtmlApproval.notNow'),
                    onPress: () => setReviewDeclined(true),
                }}
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
            networkOrigins={prepared.frameSource.networkOrigins}
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
          {requiresApproval ? (
              <RoundButton
                  testID={`${props.testID}-revoke-approval`}
                  size="small"
                  display="inverted"
                  title={t('common.reset')}
                  accessibilityLabel={t('common.reset')}
                  action={async () => { props.runtime.revoke(prepared.approval, prepared.approvalKey); }}
              />
          ) : null}
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
