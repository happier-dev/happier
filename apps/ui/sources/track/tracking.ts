import { config } from '@/config';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import PostHog, { type PostHogOptions } from 'posthog-react-native';
import { isHappierCloudServerUrl } from '@happier-dev/cli-common/happierCloud';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { getActiveServerUrl, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { loadStartupAccountPrivacyChoices } from '@/sync/domains/state/startupAccountSettings';

const ANALYTICS_FEATURE_ID = 'app.analytics' as const satisfies FeatureId;

/**
 * Ingest region, as a compile-time constant rather than an environment variable.
 *
 * PostHog Cloud US and EU are SEPARATE deployments: a project key issued in one
 * region is not valid in the other, and posting to the wrong host loses the
 * event without an error anyone sees. Our project (129992) is EU.
 *
 * This used to default to `https://us.i.posthog.com`, and app.config.js sets
 * `postHogKey` but never `postHogHost` — so unless EXPO_PUBLIC_POSTHOG_HOST was
 * exported into the build, every event from the app went to the wrong continent
 * and was dropped. `EXPO_PUBLIC_POSTHOG_HOST` still overrides this for a fork or
 * a self-hosted PostHog; the difference is that forgetting it is no longer a
 * silent data loss. apps/website/src/analytics/config.ts pins its region the
 * same way, for the same reason.
 */
const POSTHOG_DEFAULT_HOST = 'https://eu.i.posthog.com';

type TrackingProperties = NonNullable<Parameters<PostHog['capture']>[1]>;

type BeforeSendHook = Extract<NonNullable<PostHogOptions['before_send']>, (event: never) => unknown>;
type CaptureEvent = Parameters<BeforeSendHook>[0];

/**
 * Screen views are counted, not attached to the person: `$screen` is sent personless. The SDK's
 * capture() sets `$process_person_profile` itself after reading event properties
 * (posthog-react-native 4.24.1, @posthog/core 1.14.1), so only before_send, which runs after it,
 * can decide it.
 */
function sendScreenViewsPersonless(event: CaptureEvent): CaptureEvent {
    if (!event || event.event !== '$screen') return event;
    return { ...event, properties: { ...event.properties, $process_person_profile: false } };
}

/**
 * Whether the active Account allows analytics. `pending` means this device does not know the
 * Account's settings yet (new device, cleared storage, signed out): calls are held in memory
 * and sent only once the settings owner reports the Account's choice.
 */
type TrackingConsent = 'pending' | 'allowed' | 'denied';

export type TrackingClient = Readonly<{
    /** The SDK instance, only for PostHogProvider context; never call it directly. */
    client: PostHog;
    /** `serverId` names the server the event belongs to; otherwise the active server is used. */
    capture(event: string, properties?: TrackingProperties, options?: Readonly<{ serverId?: string | null }>): void;
    screen(name: string, properties?: TrackingProperties): void;
    identify(distinctId: string, properties?: TrackingProperties): void;
    group(groupType: string, groupKey: string, properties?: TrackingProperties): void;
    /** Forget the person; the next Account's choice is unknown until its settings arrive. */
    reset(): void;
    flush(): Promise<void>;
    /** The Account's analytics opt-out is known and allows analytics. */
    optIn(): void;
    /** The Account's analytics opt-out is known and set. */
    optOut(): void;
}>;

/** Coarse, id-free kind of the server an event belongs to, decided by the Happier Cloud identity owner. */
function resolveServerKind(serverId: string | null | undefined): 'cloud' | 'self_hosted' | null {
    try {
        const serverUrl = serverId ? getServerProfileById(serverId)?.serverUrl ?? '' : getActiveServerUrl();
        if (!serverUrl) return null;
        return isHappierCloudServerUrl(serverUrl) ? 'cloud' : 'self_hosted';
    } catch {
        return null;
    }
}

function withServerKind(properties: TrackingProperties | undefined, serverId?: string | null): TrackingProperties | undefined {
    const serverKind = resolveServerKind(serverId);
    return serverKind ? { ...properties, server_kind: serverKind } : properties;
}

function createTrackingClient(): TrackingClient {
    const postHogKey = config.postHogKey?.trim() ?? '';
    if (!postHogKey) {
        throw new Error('PostHog key is required when tracking is enabled');
    }

    const startupChoices = loadStartupAccountPrivacyChoices();
    let consent: TrackingConsent = startupChoices === null
        ? 'pending'
        : startupChoices.analyticsOptOut ? 'denied' : 'allowed';
    const client = new PostHog(postHogKey, {
        host: (config.postHogHost ?? POSTHOG_DEFAULT_HOST).trim() || POSTHOG_DEFAULT_HOST,
        defaultOptIn: consent === 'allowed',
        // The app uses no PostHog flags, surveys or remote config; these fetches would carry
        // the distinct id even for an opted-out Account.
        disableRemoteConfig: true,
        preloadFeatureFlags: false,
        disableSurveys: true,
        before_send: sendScreenViewsPersonless,
    });
    // Held calls of a pending device. Bounded by the session: they leave on the first decision.
    const held: Array<(posthog: PostHog) => void> = [];

    function run(call: (posthog: PostHog) => void): void {
        if (consent === 'allowed') call(client);
        else if (consent === 'pending') held.push(call);
    }

    function decide(next: 'allowed' | 'denied'): void {
        consent = next;
        const calls = held.splice(0);
        if (next === 'denied') {
            void client.optOut();
            return;
        }
        void client.optIn();
        for (const call of calls) call(client);
    }

    if (consent === 'allowed') void client.optIn();
    else void client.optOut();

    const tracking: TrackingClient = {
        client,
        capture: (event, properties, options) => {
            if (consent === 'denied') return;
            const resolved = withServerKind(properties, options?.serverId);
            run((posthog) => posthog.capture(event, resolved));
        },
        screen: (name, properties) => {
            if (consent === 'denied') return;
            const resolved = withServerKind(properties);
            run((posthog) => posthog.screen(name, resolved));
        },
        identify: (distinctId, properties) => run((posthog) => posthog.identify(distinctId, properties)),
        group: (groupType, groupKey, properties) => run((posthog) => posthog.group(groupType, groupKey, properties)),
        reset: () => {
            held.length = 0;
            consent = 'pending';
            client.reset();
            void client.optOut();
        },
        flush: () => consent === 'allowed' ? client.flush() : Promise.resolve(),
        optIn: () => decide('allowed'),
        optOut: () => decide('denied'),
    };
    // A launch count without the launch URL that PostHog's own lifecycle events carry.
    tracking.capture('app_opened');
    return tracking;
}

export const tracking = (!isEmbedWindowContext() && (config.postHogKey?.trim() ?? '') && getFeatureBuildPolicyDecision(ANALYTICS_FEATURE_ID) !== 'deny')
    ? createTrackingClient()
    : null;
