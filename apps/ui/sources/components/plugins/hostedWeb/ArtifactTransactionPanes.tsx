import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { BrowserFrameLoading } from '@/components/browser/frame/BrowserFrameLoading';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { PluginNativeArtifactResourceHandle } from '@/sync/domains/plugins/availability/nativeArtifactResource';
import type { PluginBrowserHostedWebArtifactHandle } from '@/sync/domains/plugins/availability/hostedWebArtifactLease';
import type { PluginAccountHostedArtifactPublicationResult } from '@/sync/domains/plugins/availability/accountHostedArtifactPublication';
import {
    issueActivePluginAccountHostedArtifactBrowserFrame,
    type ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    type ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactBrowserFrame';
import {
    createPluginUiHostedWebArtifactRequestFactsKey,
    PluginUiArtifactAdoptionOwner,
    type PluginUiArtifactAdoption,
    type PluginUiArtifactDaemonSource,
    type PluginUiHostedWebArtifactTechnicalAdmission,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import { PluginHostedWebPane } from './PluginHostedWebPane';
import {
    PluginHostedWebUnavailable,
    readPluginHostedWebUnavailableDiagnosticCode,
    type PluginHostedWebUnavailableDiagnosticCode,
} from './PluginHostedWebUnavailable';

function isNativeHostedArtifactPlatform(platform: LocalServicePreviewPlatform | undefined): boolean {
    return platform === 'ios' || platform === 'android' || platform === 'desktop';
}

type MountedHostedArtifact = Readonly<{
    adoption: PluginUiArtifactAdoption<'hostedWebNative', PluginNativeArtifactResourceHandle>
        | PluginUiArtifactAdoption<'hostedWebBrowser', PluginBrowserHostedWebArtifactHandle>;
    loadedRuntimeIdentity: Readonly<{
        pluginId: string;
        contributionId: string;
        artifactDigest: PluginUiHostedWebArtifactTechnicalAdmission['artifactGraph']['digest'];
    }>;
}>;

const artifactAdoptionStyles = StyleSheet.create({
    pendingFrame: {
        ...StyleSheet.absoluteFillObject,
        opacity: 0,
    },
});

/**
 * Thin renderer consumer of the UI-sync Artifact adoption owner. It holds only
 * React presentation state; source selection, cache, technical admission, and
 * consumer retirement remain in their existing canonical owners.
 */
export function PluginHostedWebArtifactAdoptionPane(props: Readonly<{
    paneProps: React.ComponentProps<typeof PluginHostedWebPane>;
    platform: LocalServicePreviewPlatform | undefined;
    reader: PluginAccountAvailabilityReader | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    exactArtifactSource: PluginUiArtifactDaemonSource | null;
    executionOrigin: PluginMachineExecutionOriginV1 | null;
    artifactSources: readonly PluginUiArtifactDaemonSource[];
    onAccountHosting: (completion: Promise<PluginAccountHostedArtifactPublicationResult>) => void;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
    /** The bound surface controller remains the lifetime authority. */
    isCurrent: () => boolean;
}>): React.ReactElement {
    const [mountedArtifact, setMountedArtifact] = React.useState<MountedHostedArtifact | null>(null);
    const [pendingArtifact, setPendingArtifact] = React.useState<MountedHostedArtifact | null>(null);
    const [unavailableDiagnosticCode, setUnavailableDiagnosticCode] = React.useState<
        PluginHostedWebUnavailableDiagnosticCode | null
    >(null);
    const [acquisitionRevision, setAcquisitionRevision] = React.useState(0);
    const currentnessRef = React.useRef(props.isCurrent);
    currentnessRef.current = props.isCurrent;
    const isCurrent = React.useCallback(() => currentnessRef.current(), []);
    const ownerRef = React.useRef<PluginUiArtifactAdoptionOwner | null>(null);
    const mountInstanceKey = props.paneProps.mountInstanceKey;
    const artifactRequestFactsKey = createPluginUiHostedWebArtifactRequestFactsKey({
        platform: props.platform,
        executionOrigin: props.executionOrigin,
        source: props.exactArtifactSource,
        sources: props.artifactSources,
        admission: props.admission,
    });

    const acquisitionEligible = (isNativeHostedArtifactPlatform(props.platform) || props.platform === 'web')
        && Boolean(props.reader && props.accountLifetime && props.admission);

    React.useEffect(() => {
        let active = true;
        setUnavailableDiagnosticCode(null);
        setPendingArtifact(null);

        if (!acquisitionEligible || !isCurrent()) {
            ownerRef.current?.retire('withdrawn');
            ownerRef.current = null;
            setMountedArtifact(null);
            setPendingArtifact(null);
            return () => {
                active = false;
            };
        }

        const owner = ownerRef.current ?? new PluginUiArtifactAdoptionOwner({ isCurrent });
        ownerRef.current = owner;

        void (async () => {
            const adoptionInput = {
                reader: props.reader!,
                executionOrigin: props.executionOrigin,
                artifactGraph: props.admission!.artifactGraph,
                cacheIdentity: props.admission!.cacheIdentity,
                accountLifetime: props.accountLifetime!,
                hostedWebPolicy: props.admission!.hostedWebPolicy,
                daemons: props.artifactSources,
                ...(props.admission!.daemonProjectionSelection
                    ? {
                        daemonProjectionSelection: {
                            ...props.admission!.daemonProjectionSelection,
                            isCurrent,
                        },
                    }
                    : {}),
                // The Artifact producer may use its incumbent verified cache
                // without a daemon. A daemon candidate needs the selected
                // transport; Account materialization provenance is optional.
                // Host never supplies app or Account byte-source adapters.
                ...(props.exactArtifactSource
                    ? {
                        daemon: props.exactArtifactSource,
                    }
                    : {}),
            };
            const acquired = props.platform === 'web'
                ? await owner.adoptHostedWebBrowser(adoptionInput)
                : await owner.adoptHostedWebNative(adoptionInput);
            if (acquired.kind !== 'available') {
                if (active && isCurrent()) {
                    setUnavailableDiagnosticCode(
                        readPluginHostedWebUnavailableDiagnosticCode(acquired.code) ?? 'response_invalid',
                    );
                }
                return;
            }
            if (acquired.adoption.handle.accountHosting) props.onAccountHosting(acquired.adoption.handle.accountHosting);
            if (!active || !isCurrent()) {
                acquired.adoption.dispose();
                return;
            }
            const admission = props.admission!;
            const mounted = Object.freeze({
                adoption: acquired.adoption,
                loadedRuntimeIdentity: Object.freeze({
                    pluginId: admission.cacheIdentity.pluginId,
                    contributionId: admission.cacheIdentity.contributionId,
                    artifactDigest: admission.artifactGraph.digest,
                }),
            });
            setPendingArtifact(mounted);
        })().catch(() => {
            if (active && isCurrent()) setUnavailableDiagnosticCode('transport_unavailable');
        });

        return () => {
            active = false;
        };
    // Equivalent parsed projection objects must not retire an otherwise-current
    // native token. This dependency key contains every Artifact request fact;
    // it is deliberately not a cache or persistence identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        props.accountLifetime,
        props.reader,
        acquisitionRevision,
        isCurrent,
        mountInstanceKey,
        artifactRequestFactsKey,
    ]);

    React.useEffect(() => () => {
        ownerRef.current?.dispose();
        ownerRef.current = null;
    }, []);

    const retry = () => setAcquisitionRevision((revision) => revision + 1);
    const renderPane = (
        mounted: MountedHostedArtifact | null,
        candidate: boolean,
    ) => (
        <PluginHostedWebPane
            {...props.paneProps}
            nativeArtifactAdoption={mounted?.adoption.kind === 'hostedWebNative' ? mounted.adoption : null}
            browserArtifactAdoption={mounted?.adoption.kind === 'hostedWebBrowser' ? mounted.adoption : null}
            nativeArtifactLoadedRuntimeIdentity={mounted?.loadedRuntimeIdentity ?? null}
            unavailableDiagnosticCode={candidate ? null : unavailableDiagnosticCode}
            onUnavailableRetry={retry}
            {...(candidate && mounted ? {
                focusEligible: false,
                artifactCandidatePreparing: true,
                retainCandidateAdoptionOnUnmount: true,
                onArtifactCandidateReady: () => {
                    if (!mounted.adoption.commit()) return;
                    setMountedArtifact(mounted);
                    setPendingArtifact(null);
                    setUnavailableDiagnosticCode(null);
                },
                onArtifactCandidateFailure: (code: string) => {
                    mounted.adoption.fail(code);
                    setPendingArtifact(null);
                    setUnavailableDiagnosticCode(readPluginHostedWebUnavailableDiagnosticCode(code) ?? 'response_invalid');
                },
            } : {})}
        />
    );
    // No source is expected while the admitted acquisition is still pending.
    // Keep terminal diagnostics for settled refusals, not this initial wait.
    if (!mountedArtifact && !pendingArtifact && unavailableDiagnosticCode === null
        && acquisitionEligible && isCurrent()) {
        return <BrowserFrameLoading testID="plugin-hosted-web-frame" />;
    }
    if (!mountedArtifact) return renderPane(pendingArtifact, pendingArtifact !== null);
    return (
        <>
            {unavailableDiagnosticCode ? (
                <PluginHostedWebUnavailable
                    diagnosticCode={unavailableDiagnosticCode}
                    onRetry={retry}
                    recoveryAction={props.paneProps.unavailableAction}
                />
            ) : null}
            {renderPane(mountedArtifact, false)}
            {pendingArtifact ? (
                <View pointerEvents="none" style={artifactAdoptionStyles.pendingFrame}>
                    {renderPane(pendingArtifact, true)}
                </View>
            ) : null}
        </>
    );
}

type BrowserHostedArtifactFrameRequest = Omit<
    ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    'accountLifetime' | 'signal'
>;

/**
 * Availability selects the release coordinate; the generated projection
 * supplies the independently admitted Artifact graph. Browser capability
 * issuance proceeds only when those two owners agree exactly. This validates
 * their handoff without selecting bytes, a cache, or a transport fallback.
 */
function readBrowserHostedArtifactFrameRequest(input: Readonly<{
    reader: PluginAccountAvailabilityReader | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
}>): BrowserHostedArtifactFrameRequest | null {
    const { reader, admission } = input;
    if (!reader || !admission) return null;
    const { artifactGraph, cacheIdentity } = admission;
    if (
        artifactGraph.tier !== 'hostedWeb'
        || cacheIdentity.platform !== 'web'
        || cacheIdentity.artifactId !== artifactGraph.artifactId
        || cacheIdentity.artifactDigest !== artifactGraph.digest
    ) {
        return null;
    }

    let currentArtifact: ReturnType<PluginAccountAvailabilityReader['readCurrentArtifact']>;
    try {
        currentArtifact = reader.readCurrentArtifact({
            pluginId: cacheIdentity.pluginId,
            contributionId: cacheIdentity.contributionId,
            tier: artifactGraph.tier,
            platform: cacheIdentity.platform,
        });
    } catch {
        return null;
    }
    if (currentArtifact.kind !== 'available') return null;

    const selected = currentArtifact.artifact;
    if (
        selected.pluginId !== cacheIdentity.pluginId
        || selected.contributionId !== cacheIdentity.contributionId
        || selected.artifactId !== artifactGraph.artifactId
        || selected.tier !== artifactGraph.tier
        || selected.platform !== cacheIdentity.platform
        || selected.digest !== artifactGraph.digest
        || selected.digest !== cacheIdentity.artifactDigest
    ) {
        return null;
    }

    return Object.freeze({
        release: Object.freeze({
            pluginId: selected.pluginId,
            version: selected.releaseVersion,
        }),
        slot: Object.freeze({
            contributionId: selected.contributionId,
            artifactId: selected.artifactId,
            tier: selected.tier,
            platform: selected.platform,
        }),
        expectedArtifactDigest: selected.digest,
    });
}

function browserHostedArtifactFrameRequestKey(
    request: BrowserHostedArtifactFrameRequest | null,
): string | null {
    if (!request) return null;
    return [
        request.release.pluginId,
        request.release.version,
        request.slot.contributionId,
        request.slot.tier,
        request.slot.platform,
        request.expectedArtifactDigest,
    ].join('\u001f');
}

/**
 * Browser-only presentation consumer for the issued Artifact capability URL.
 * Its state is mount-local and cleared on the incumbent Account retirement;
 * the issuer and server remain the sole capability/byte-source owners.
 */
export function PluginHostedWebBrowserArtifactFramePane(props: Readonly<{
    paneProps: React.ComponentProps<typeof PluginHostedWebPane>;
    reader: PluginAccountAvailabilityReader | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
    /** The bound surface controller remains the lifetime authority. */
    isCurrent: () => boolean;
}>): React.ReactElement {
    const [frame, setFrame] = React.useState<ActivePluginAccountHostedArtifactBrowserFrameIssueResult | null>(null);
    const [pendingFrame, setPendingFrame] = React.useState<Extract<
        ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
        { kind: 'available' }
    > | null>(null);
    const [candidateFailure, setCandidateFailure] = React.useState<PluginHostedWebUnavailableDiagnosticCode | null>(null);
    const pendingFrameRef = React.useRef(pendingFrame);
    pendingFrameRef.current = pendingFrame;
    const [expiredFrame, setExpiredFrame] = React.useState<Extract<
        ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
        { kind: 'available' }
    > | null>(null);
    const [issuanceRevision, setIssuanceRevision] = React.useState(0);
    const currentnessRef = React.useRef(props.isCurrent);
    currentnessRef.current = props.isCurrent;
    const isCurrent = React.useCallback(() => currentnessRef.current(), []);
    const request = readBrowserHostedArtifactFrameRequest({
        reader: props.reader,
        admission: props.admission,
    });
    const requestRef = React.useRef(request);
    requestRef.current = request;
    const requestKey = browserHostedArtifactFrameRequestKey(request);
    const technicalAdmissionKey = createPluginUiHostedWebArtifactRequestFactsKey({
        platform: 'web',
        source: null,
        admission: props.admission,
    });
    const mountInstanceKey = props.paneProps.mountInstanceKey;

    React.useLayoutEffect(() => {
        const currentRequest = requestRef.current;
        const accountLifetime = props.accountLifetime;
        const controller = new AbortController();
        let mounted = true;
        const retire = () => {
            controller.abort();
            if (mounted) {
                setFrame(null);
                setPendingFrame(null);
                setExpiredFrame(null);
            }
        };

        if (!currentRequest || !accountLifetime || !accountLifetime.isCurrent() || !isCurrent()) {
            setFrame(null);
            setPendingFrame(null);
            setExpiredFrame(null);
            return () => {
                mounted = false;
                controller.abort();
            };
        }

        const retirement = accountLifetime.onRetire(retire);
        void issueActivePluginAccountHostedArtifactBrowserFrame({
            ...currentRequest,
            accountLifetime,
            signal: controller.signal,
        }).then((result) => {
            if (!mounted || controller.signal.aborted || !accountLifetime.isCurrent() || !isCurrent()) {
                return;
            }
            if (result.kind === 'available') {
                setPendingFrame(result);
                setCandidateFailure(null);
            } else {
                setCandidateFailure(readPluginHostedWebUnavailableDiagnosticCode(result.code) ?? 'response_invalid');
                setFrame((current) => current ?? result);
            }
        }).catch(() => {
            if (!mounted || controller.signal.aborted || !accountLifetime.isCurrent() || !isCurrent()) {
                return;
            }
            setCandidateFailure('transport_unavailable');
            setFrame((current) => current ?? Object.freeze({ kind: 'unavailable' as const, code: 'transport_unavailable' as const }));
        });

        return () => {
            mounted = false;
            controller.abort();
            retirement.dispose();
        };
    // These keys contain the issued coordinate and the existing technical
    // admission facts. `issuanceRevision` changes only when the user invokes
    // the unavailable state's Retry; expiry itself never starts renewal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        props.accountLifetime,
        props.reader,
        issuanceRevision,
        isCurrent,
        mountInstanceKey,
        requestKey,
        technicalAdmissionKey,
    ]);

    const availableFrame = frame?.kind === 'available' ? frame : null;
    React.useEffect(() => {
        if (!availableFrame) return;
        const remainingMs = availableFrame.value.expiresAt - Date.now();
        if (remainingMs <= 0) {
            setExpiredFrame(availableFrame);
            return;
        }
        const timeout = setTimeout(
            () => {
                setExpiredFrame(availableFrame);
            },
            Math.min(remainingMs, 2_147_483_647),
        );
        return () => {
            clearTimeout(timeout);
        };
    }, [availableFrame]);
    const unavailableDiagnosticCode = candidateFailure ?? (availableFrame !== null && expiredFrame === availableFrame
        ? 'hosted_web_preview_expired'
        : frame?.kind === 'unavailable' ? frame.code : null);
    const appliedFrame = availableFrame !== null && expiredFrame !== availableFrame ? availableFrame : null;
    const retry = () => setIssuanceRevision((revision) => revision + 1);
    const renderFramePane = (
        candidate: Extract<ActivePluginAccountHostedArtifactBrowserFrameIssueResult, { kind: 'available' }> | null,
        pending: boolean,
    ) => (
        <PluginHostedWebPane
            {...props.paneProps}
            endpointUrl={candidate?.value.url ?? null}
            expiresAt={candidate?.value.expiresAt ?? null}
            opaqueArtifactFrame
            unavailableDiagnosticCode={pending ? null : unavailableDiagnosticCode}
            onUnavailableRetry={unavailableDiagnosticCode === null ? undefined : retry}
            {...(pending && candidate ? {
                focusEligible: false,
                artifactCandidatePreparing: true,
                onArtifactCandidateReady: () => {
                    if (pendingFrameRef.current !== candidate) return;
                    setFrame(candidate);
                    setPendingFrame(null);
                    setExpiredFrame(null);
                    setCandidateFailure(null);
                },
                onArtifactCandidateFailure: (code: string) => {
                    if (pendingFrameRef.current !== candidate) return;
                    setPendingFrame(null);
                    setCandidateFailure(readPluginHostedWebUnavailableDiagnosticCode(code) ?? 'response_invalid');
                },
            } : {})}
        />
    );
    if (frame === null && pendingFrame === null && unavailableDiagnosticCode === null
        && request !== null && props.accountLifetime?.isCurrent() && isCurrent()) {
        return <BrowserFrameLoading testID="plugin-hosted-web-frame" />;
    }
    if (!appliedFrame) return renderFramePane(pendingFrame, pendingFrame !== null);
    return (
        <>
            {unavailableDiagnosticCode ? (
                <PluginHostedWebUnavailable
                    diagnosticCode={unavailableDiagnosticCode}
                    onRetry={retry}
                    recoveryAction={props.paneProps.unavailableAction}
                />
            ) : null}
            {renderFramePane(appliedFrame, false)}
            {pendingFrame ? (
                <View pointerEvents="none" style={artifactAdoptionStyles.pendingFrame}>
                    {renderFramePane(pendingFrame, true)}
                </View>
            ) : null}
        </>
    );
}
