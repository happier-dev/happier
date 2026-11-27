import { captureAccountEvent } from './analyticsConsent';
import { tracking } from './tracking';

// Re-export tracking for direct access
export { tracking } from './tracking';
export {
    applyAnalyticsOptOut,
    getTrackingAnonymousUserId,
    initializeTracking,
    subscribeTrackingAnonymousUserId,
    trackLogout,
} from './analyticsConsent';

/**
 * Auth events
 */
export function trackAccountCreated() {
    captureAccountEvent('account_created');
}

export function trackAccountRestored() {
    captureAccountEvent('account_restored');
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

// Voice events name the provider only: no session id, no error text.
export function trackVoiceSessionToggled(providerId: string) {
    tracking?.capture('voice_session_toggled', { providerId });
}

export function trackVoiceSessionError(providerId: string) {
    tracking?.capture('voice_session_error', { providerId });
}

export function trackVoiceRecording(action: 'start' | 'stop') {
    tracking?.capture('voice_recording', { action });
}

export function trackPermissionResponse(allowed: boolean) {
    tracking?.capture('permission_response', { allowed });
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

/** A fixed reason only: the SDK's error text is not sent. */
export type PaywallErrorReason = 'not_initialized' | 'present_failed' | 'exception';

export function trackPaywallError(reason: PaywallErrorReason) {
    tracking?.capture('paywall_error', { reason });
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
