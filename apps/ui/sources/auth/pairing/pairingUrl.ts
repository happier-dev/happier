import {
    encodeHomeQrInviteV2Payload,
    parseHomeQrInviteV2Payload,
    type HomeQrInviteV2,
} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { tryCreateQRMatrix } from '@/components/qr/qrMatrix';
import { randomUUID } from '@/platform/randomUUID';
import { isAcceptedHappierUrlProtocol, resolveAppUrlScheme } from '@/utils/url/appScheme';
import {
    HOME_QR_ENTRY_INTENT_ROUTE_PARAM,
    type HomeQrEntryIntent,
} from './homeQrEntryIntent';

export type HomeQrInviteDeepLinkResult = Readonly<{ invite: HomeQrInviteV2 }>;
export type LegacyPairingDeepLinkClassification = Readonly<{
    kind: 'legacy_pairing_update_required';
}>;

export const HOME_QR_INVITE_RESTORE_ROUTE_PARAM = 'pairingHandoff';

type PendingHomeQrInviteRestoreHandoff = Readonly<{
    handle: string;
    rawLink: string;
}>;

let pendingHomeQrInviteRestoreHandoff: PendingHomeQrInviteRestoreHandoff | null = null;

function isValidPairingLinkTarget(url: URL): boolean {
    if (!isAcceptedHappierUrlProtocol(url.protocol)) return false;

    const pathname = url.pathname === 'pair' ? '/pair' : (url.pathname ?? '');
    const hostname = url.hostname ?? '';

    if (pathname === '/pair') return true;
    if (hostname === 'pair' && (pathname === '' || pathname === '/')) return true;

    return false;
}

function isValidLegacyServerUrl(raw: string): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }

    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
}

/**
 * Recognizes the immutable released V1 invite shape only far enough to refuse it safely.
 * Decoded V1 material is deliberately never returned to callers.
 */
export function classifyLegacyPairingDeepLink(rawLink: string): LegacyPairingDeepLinkClassification | null {
    if (rawLink.length === 0 || rawLink.length > 4_096) return null;

    let url: URL;
    try {
        url = new URL(rawLink);
    } catch {
        return null;
    }

    if (!isValidPairingLinkTarget(url)) return null;
    if (url.hash) return null;

    const entries = [...url.searchParams.entries()];
    const allowedKeys = new Set(['v', 'pairId', 'secret', 'server']);
    if (entries.some(([key]) => !allowedKeys.has(key))) return null;
    const count = (key: string) => entries.filter(([entryKey]) => entryKey === key).length;
    if (count('v') !== 1 || count('pairId') !== 1 || count('secret') !== 1 || count('server') > 1) return null;
    if (url.searchParams.get('v') !== '1') return null;

    const pairId = url.searchParams.get('pairId');
    const secret = url.searchParams.get('secret');
    if (!pairId || !secret) return null;

    const server = url.searchParams.get('server');
    if (count('server') === 1 && (!server || !isValidLegacyServerUrl(server))) return null;

    return { kind: 'legacy_pairing_update_required' };
}

/** Build a v2 link carrying one opaque, bounded invite payload. */
export function buildHomeQrInviteDeepLink(input: Readonly<{ invite: HomeQrInviteV2 }>): string {
    const payload = encodeHomeQrInviteV2Payload(input.invite);
    const link = `${resolveAppUrlScheme()}:///pair?v=2&payload=${encodeURIComponent(payload)}`;
    return link;
}

export type RenderableHomeQrInviteDeepLinkResult =
    | Readonly<{ ok: true; link: string; invite: HomeQrInviteV2 }>
    | Readonly<{ ok: false; reason: 'invalid_invite' }>
    | Readonly<{ ok: false; reason: 'qr_unavailable'; link: string }>;

/**
 * Builds the exact secret-bearing deep link that the Add Device surface will
 * render and admits it through the real medium-error-correction QR encoder.
 * This keeps protocol parsing bounds separate from physical QR capacity and
 * turns an encoder exception into a typed unavailable result. A valid invite
 * over encoder capacity still returns its exact link so the pairing stays
 * live with the warned link-only fallback (lane-05 A6); only a malformed
 * invite is rejected without a link.
 */
export function buildRenderableHomeQrInviteDeepLink(
    input: Readonly<{ invite: HomeQrInviteV2 }>,
): RenderableHomeQrInviteDeepLinkResult {
    const invite = input.invite;
    let link: string;
    try {
        link = buildHomeQrInviteDeepLink({ invite });
    } catch {
        return { ok: false, reason: 'invalid_invite' };
    }
    const matrix = tryCreateQRMatrix(link, 'medium');
    if (!matrix.ok) return { ok: false, reason: matrix.reason, link };
    return { ok: true, link, invite };
}

/** Parse only the v2 opaque invite shape; v1 links stay on the compatibility reader. */
export function parseHomeQrInviteDeepLink(rawLink: string, expected?: Readonly<{ homeServerIdentityId: string; direction: HomeQrInviteV2['direction'] }>): HomeQrInviteDeepLinkResult | null {
    let url: URL;
    try {
        url = new URL(rawLink);
    } catch {
        return null;
    }
    if (!isValidPairingLinkTarget(url)) return null;
    if (url.hash) return null;
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 2 || url.searchParams.get('v') !== '2' || !url.searchParams.has('payload')) return null;
    const invite = parseHomeQrInviteV2Payload(url.searchParams.get('payload') ?? '', { nowMs: Date.now() });
    if (!invite) return null;
    if (expected && (invite.home.homeServerIdentityId !== expected.homeServerIdentityId || invite.direction !== expected.direction)) return null;
    return { invite };
}

/**
 * Consume the current in-memory invite handoff exactly once. The route handle is
 * deliberately non-authoritative and carries no QR material in navigation state.
 */
export function consumeHomeQrInviteRestoreHandoff(handle: string): string | null {
    const pending = pendingHomeQrInviteRestoreHandoff;
    if (!pending || pending.handle !== handle) return null;
    pendingHomeQrInviteRestoreHandoff = null;
    return parseHomeQrInviteDeepLink(pending.rawLink) ? pending.rawLink : null;
}

/** Route a validated V2 invite to the canonical restore controller via one in-memory handoff. */
export function buildHomeQrInviteRestoreRoutePath(
    rawLink: string,
    entryIntent: HomeQrEntryIntent,
): string | null {
    const link = String(rawLink ?? '').trim();
    if (!parseHomeQrInviteDeepLink(link)) return null;
    const handle = `home-qr-${randomUUID()}`;
    pendingHomeQrInviteRestoreHandoff = { handle, rawLink: link };
    return `/restore?${HOME_QR_INVITE_RESTORE_ROUTE_PARAM}=${handle}&${HOME_QR_ENTRY_INTENT_ROUTE_PARAM}=${entryIntent}`;
}
