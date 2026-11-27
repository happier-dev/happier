import { getActiveServerSnapshot, isHappierCloudServerUrl, subscribeActiveServer } from '@/sync/domains/server/serverProfiles';
import { clearAnalyticsPropertiesSent } from '@/sync/domains/state/persistence';
import { tracking } from './tracking';

// Analytics identity and consent: the one owner of what PostHog may identify, register and send.

let trackingAnonymousUserId: string | null = null;
let identifiedAnonymousUserId: string | null = null;
// The signed-in account's analytics setting, once applied. Until it is 'allowed' the client stays
// opted out (it starts every launch opted out) and nothing is identified or registered.
let consent: 'unknown' | 'allowed' | 'denied' = 'unknown';
// Sign-up and restore fire before the account's setting is known; they wait for it here.
let heldAccountEvents: Array<'account_created' | 'account_restored'> = [];
let unsubscribeActiveServer: (() => void) | null = null;
const trackingAnonymousUserIdListeners = new Set<() => void>();

function publishTrackingAnonymousUserIdChange() {
    trackingAnonymousUserIdListeners.forEach((listener) => listener());
}

function identifyIfAllowed() {
    if (!tracking || consent !== 'allowed' || !trackingAnonymousUserId) return;
    if (identifiedAnonymousUserId === trackingAnonymousUserId) return;
    identifiedAnonymousUserId = trackingAnonymousUserId;
    tracking.identify(trackingAnonymousUserId, { name: trackingAnonymousUserId });
}

/** A coarse server kind only; never the server URL, hostname or any id. */
function registerServerKind() {
    if (!tracking || consent !== 'allowed') return;
    const serverUrl = getActiveServerSnapshot().serverUrl;
    if (!serverUrl) return;
    tracking.register({ server_kind: isHappierCloudServerUrl(serverUrl) ? 'cloud' : 'self_hosted' });
}

/**
 * The one place that applies the account's analytics setting to PostHog.
 */
export function applyAnalyticsOptOut(optOut: boolean) {
    if (!tracking) return;
    const wasAllowed = consent === 'allowed';
    if (optOut) {
        tracking.optOut();
        consent = 'denied';
        heldAccountEvents = [];
        identifiedAnonymousUserId = null;
        if (wasAllowed) publishTrackingAnonymousUserIdChange();
        return;
    }
    tracking.optIn();
    consent = 'allowed';
    if (!wasAllowed) {
        registerServerKind();
        unsubscribeActiveServer ??= subscribeActiveServer(() => registerServerKind());
        publishTrackingAnonymousUserIdChange();
    }
    identifyIfAllowed();
    const held = heldAccountEvents;
    heldAccountEvents = [];
    for (const event of held) tracking.capture(event);
}

/** Sign-up and restore: sent now if allowed, after the setting is applied if it is not known yet. */
export function captureAccountEvent(event: 'account_created' | 'account_restored') {
    if (!tracking) return;
    if (consent === 'allowed') tracking.capture(event);
    else if (consent === 'unknown') heldAccountEvents.push(event);
}

/**
 * Initialize tracking with an anonymous user ID.
 * Should be called once during auth initialization. Identification waits for consent.
 */
export function initializeTracking(anonymousUserId: string) {
    if (trackingAnonymousUserId !== null && trackingAnonymousUserId !== anonymousUserId && consent !== 'unknown') {
        // Another account signed in: its own setting decides, so stop until that is applied.
        tracking?.optOut();
        consent = 'unknown';
        identifiedAnonymousUserId = null;
    }
    trackingAnonymousUserId = anonymousUserId;
    publishTrackingAnonymousUserIdChange();
    identifyIfAllowed();
}

/** The anonymous id to attach analytics to, or null while analytics is not allowed. */
export function getTrackingAnonymousUserId(): string | null {
    return consent === 'allowed' ? trackingAnonymousUserId : null;
}

export function subscribeTrackingAnonymousUserId(listener: () => void): () => void {
    trackingAnonymousUserIdListeners.add(listener);
    return () => trackingAnonymousUserIdListeners.delete(listener);
}

export function trackLogout() {
    trackingAnonymousUserId = null;
    identifiedAnonymousUserId = null;
    // reset() also clears the persisted opt-in, so the client is opted out again until the
    // next account's setting is applied.
    consent = 'unknown';
    heldAccountEvents = [];
    publishTrackingAnonymousUserIdChange();
    tracking?.reset();
    // reset() drops the SDK's identity and $groups, so person and group properties are sent in full again.
    clearAnalyticsPropertiesSent();
}
