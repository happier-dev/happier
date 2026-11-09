import { Platform } from 'react-native';
import { focusTerminalConnectHome } from './focusTerminalConnectHome';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { isTerminalPairingExpired } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { getActiveServerUrl, resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { shouldSwitchToServerUrl } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveTerminalConnectPreAuthTarget, type ParsedTerminalConnectUrl, type TerminalConnectPreAuthTargetDecision } from '@/utils/path/terminalConnectUrl';
import { promptLegacyPairingUpdateRequired } from '@/auth/pairing/legacyPairingUpdateRequired';

export type TerminalConnectLinkState = 'ready' | 'invalid' | 'expired' | 'update_required';

/** Parsing owns shape; terminal admission owns the request's issued expiry at each new entry/action. */
export function resolveTerminalConnectLinkState(request: ParsedTerminalConnectUrl | null): TerminalConnectLinkState {
    if (!request) return 'invalid';
    if (request.compatibility?.admission === 'update_required') return 'update_required';
    if (request.pairing && isTerminalPairingExpired(request.pairing)) return 'expired';
    return 'ready';
}

export type TerminalConnectEntryResult = 'opened' | 'expired' | 'update_required' | 'unavailable' | 'declined';

/** Opening a pasted link retains custody and navigates without approving or putting secrets in history. */
export async function openTerminalConnectApproval(request: ParsedTerminalConnectUrl, options: Readonly<{
    navigate: (href: string) => void;
    refreshAuth: () => Promise<void>;
}>): Promise<TerminalConnectEntryResult> {
    const state = resolveTerminalConnectLinkState(request);
    if (state === 'expired') return state;
    if (state === 'update_required') {
        if (await promptLegacyPairingUpdateRequired() === 'scan_new_qr') options.navigate('/scan/terminal');
        return 'update_required';
    }
    const target = await prepareTerminalConnect(request);
    if (!target?.canNavigateToAuth) {
        Modal.alert(t('welcome.serverUnavailableTitle'), t('welcome.serverUnavailableBody', { serverUrl: target?.pendingServerUrl ?? '' }));
        return 'unavailable';
    }
    const serverUrl = await focusTerminalConnectTarget({ request, serverUrl: target.pendingServerUrl, refreshAuth: options.refreshAuth });
    if (serverUrl) options.navigate(terminalConnectResumeHref());
    return serverUrl ? 'opened' : 'declined';
}

/** Capture before discovery or navigation can unmount the input adapter. */
export function captureTerminalConnect(request: ParsedTerminalConnectUrl, serverUrl?: string): void {
    const pending = {
        publicKeyB64Url: request.publicKeyB64Url,
        serverUrl: normalizeServerUrl(serverUrl ?? request.homeConnectionDescriptor?.canonicalServerUrl ?? request.serverUrl ?? getActiveServerUrl()),
        serverIdentityId: request.serverIdentityId ?? '',
        ...(request.pairing ? { pairing: request.pairing } : {}),
        ...(request.supportsTokenOnly ? { supportsTokenOnly: true as const } : {}),
        ...(request.homeConnectionDescriptor ? { homeConnectionDescriptor: request.homeConnectionDescriptor } : {}),
    };
    setPendingTerminalConnect(pending);
}

export async function prepareTerminalConnect(
    request: ParsedTerminalConnectUrl,
    allowLegacyLoopbackOverride = false,
): Promise<TerminalConnectPreAuthTargetDecision | null> {
    captureTerminalConnect(request);
    const target = await resolveTerminalConnectPreAuthTarget({
        requestedServerUrl: request.serverUrl,
        activeServerUrl: getActiveServerUrl(),
        ...(request.homeConnectionDescriptor ? { homeConnectionDescriptor: request.homeConnectionDescriptor } : {}),
        allowLegacyLoopbackOverride,
    });
    if (target) captureTerminalConnect(request, target.pendingServerUrl);
    return target;
}

/** Routes, scanner sign-in and root resume share the same Home focus operation. */
export async function focusTerminalConnectTarget(params: Readonly<{
    request: ParsedTerminalConnectUrl;
    serverUrl: string;
    refreshAuth: () => Promise<void>;
}>): Promise<string | null> {
    if (params.request.homeConnectionDescriptor) {
        // Matching addresses do not establish the link's identity or transport.
        // The existing adoption owner must install its advisory descriptor before sign-in too.
        const profile = await focusTerminalConnectHome({ descriptor: params.request.homeConnectionDescriptor, refreshAuth: params.refreshAuth });
        if (!profile) return null;
        captureTerminalConnect(params.request, profile.serverUrl);
        return profile.serverUrl;
    }
    if (!shouldSwitchToServerUrl({ targetServerUrl: params.serverUrl, activeServerUrl: getActiveServerUrl() })) {
        return params.serverUrl;
    }
    let profile = resolveUniqueServerProfileByUrl(params.serverUrl);
    if (!profile) {
        const connected = await connectHomeAtAddress({
            serverUrl: params.serverUrl, source: 'url',
            confirmInsecureHttp: confirmInsecureHomeHttp, confirmCanonicalUrl: confirmCanonicalHomeUrl,
        });
        if (connected.kind === 'declined') {
            clearPendingTerminalConnect();
            return null;
        }
        if (connected.kind !== 'connected') {
            Modal.alert(t('common.error'), homeConnectFailureMessage(connected) ?? t('common.error'));
            return null;
        }
        profile = connected.profile;
    }
    const switched = await setActiveServerAndSwitch({
        serverId: profile.id,
        scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
        refreshAuth: params.refreshAuth,
    });
    if (switched === 'blocked') return null;
    captureTerminalConnect(params.request, profile.serverUrl);
    return profile.serverUrl;
}

export function terminalConnectResumeHref(): '/terminal/connect' | '/terminal' {
    return Platform.OS === 'web' ? '/terminal/connect' : '/terminal';
}
