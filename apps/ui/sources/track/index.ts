import { clearAnalyticsPropertiesSent } from '@/sync/domains/state/analyticsSendState';

import { tracking } from './tracking';

// Re-export tracking for direct access
export { tracking } from './tracking';

let trackingAnonymousUserId: string | null = null;
const trackingAnonymousUserIdListeners = new Set<() => void>();

function publishTrackingAnonymousUserIdChange() {
    trackingAnonymousUserIdListeners.forEach((listener) => listener());
}

/**
 * Initialize tracking with an anonymous user ID.
 * Should be called once during auth initialization.
 */
export function initializeTracking(anonymousUserId: string) {
    trackingAnonymousUserId = anonymousUserId;
    publishTrackingAnonymousUserIdChange();
    tracking?.identify(anonymousUserId);
}

export function getTrackingAnonymousUserId(): string | null {
    return trackingAnonymousUserId;
}

export function subscribeTrackingAnonymousUserId(listener: () => void): () => void {
    trackingAnonymousUserIdListeners.add(listener);
    return () => trackingAnonymousUserIdListeners.delete(listener);
}

/**
 * Auth events
 */
export function trackAccountCreated() {
    tracking?.capture('account_created');
}

export function trackAccountRestored() {
    tracking?.capture('account_restored');
}

export function trackAuthEnrollmentTransientRetry() {
    tracking?.capture('auth_enrollment_outcome', {
        flow: 'account_qr',
        outcome: 'transient_retry',
    });
}

export function trackLogout() {
    trackingAnonymousUserId = null;
    publishTrackingAnonymousUserIdChange();
    tracking?.reset();
    // reset() drops the SDK's identity and $groups, so person and group properties are sent in full again.
    clearAnalyticsPropertiesSent();
}

/**
 * Core user interactions
 */
export function trackConnectAttempt() {
    tracking?.capture('connect_attempt');
}

export function trackMessageSent() {
    tracking?.capture('message_sent');
}

/**
 * Paywall events
 */
export function trackPaywallButtonClicked() {
    tracking?.capture('paywall_button_clicked');
}

export function trackPaywallPresented() {
    tracking?.capture('paywall_presented');
}

export function trackPaywallPurchased() {
    tracking?.capture('paywall_purchased');
}

export function trackPaywallCancelled() {
    tracking?.capture('paywall_cancelled');
}

export function trackPaywallRestored() {
    tracking?.capture('paywall_restored');
}

/** Paywall failures leave the device as a code; the SDK's message stays local. */
export type PaywallErrorCode = 'not_initialized' | 'presentation_failed' | 'exception';

export function trackPaywallError(code: PaywallErrorCode) {
    tracking?.capture('paywall_error', { error_code: code });
}

/**
 * Review request events
 */
export function trackReviewPromptShown() {
    tracking?.capture('review_prompt_shown');
}

export function trackReviewPromptResponse(likesApp: boolean) {
    tracking?.capture('review_prompt_response', { likes_app: likesApp });
}

export function trackReviewStoreShown() {
    tracking?.capture('review_store_shown');
}

export function trackReviewRetryScheduled(daysUntilRetry: number) {
    tracking?.capture('review_retry_scheduled', { days_until_retry: daysUntilRetry });
}

/**
 * What's New / Changelog events
 */
export function trackWhatsNewClicked() {
    tracking?.capture('whats_new_clicked');
}

/**
 * Friends feature events
 *
 * NOTE: We're measuring how interested people are in the friend feature as-is,
 * considering removing the tab to avoid confusion.
 */
export function trackFriendsSearch() {
    tracking?.capture('friends_search');
}

export function trackFriendsProfileView() {
    tracking?.capture('friends_profile_view');
}

export function trackFriendsConnect() {
    tracking?.capture('friends_connect');
}
