/**
 * The stable identities this plugin declares once and every other module reuses.
 *
 * They live apart from the manifest so that runtime modules can name the exact
 * Connected Account purpose without importing the manifest that registers them, and so
 * a second literal can never drift from the value the host actually admitted.
 *
 * The Connected Account purpose doubles as this plugin's connected-account contribution
 * id and as its `hostAccess` grant id, so it is spelled in the one form all three
 * canonical parsers accept: a lowercase, dot-free contribution identifier. A dotted
 * spelling is a valid purpose string but is rejected as a contribution local id and as
 * an Action `hostAccess` reference, which would leave the grant unreferenceable.
 */

/** The plugin id of this source. */
export const POSTHOG_PLUGIN_ID = 'happier.posthog';

/** The Triage source contribution id inside the target's `sources` point. */
export const POSTHOG_SOURCE_CONTRIBUTION_ID = 'posthog-error-tracking';

/** The declared Connected Account purpose, contribution id, and host-access grant id. */
export const POSTHOG_CONNECTED_ACCOUNT_PURPOSE = 'posthog-api';

/** The network host-access grant covering this source's provider requests. */
export const POSTHOG_NETWORK_HOST_ACCESS_ID = 'posthog-network';

/** The native detail renderer bound to the source's `detail` surface. */
export const POSTHOG_DETAIL_RENDERER_ID = 'posthog-issue-detail';

/** The direct-disclosure Composer reference for one selected PostHog occurrence. */
export const POSTHOG_EVIDENCE_REFERENCE_ID = 'posthog-evidence';

/**
 * The React Native artifact the native renderer mounts.
 *
 * It must equal `POSTHOG_DETAIL_UI_ARTIFACT_ID` in `uiBuildIdentity.mjs`: the manifest's
 * `renderers[].artifact` is what the host looks up in the staged UI graph, and
 * `src/uiBuildConfig.test.ts` is what keeps the two from drifting apart.
 */
export const POSTHOG_DETAIL_ARTIFACT_ID = 'posthog-issue-detail-native';

/**
 * The declarative renderer for a host that cannot mount the native artifact.
 *
 * It is declared, not bound: the `detail` surface binds the native renderer, and this
 * one exists so a host without a React Native surface still has a truthful body to show
 * rather than an empty pane.
 */
export const POSTHOG_DETAIL_FALLBACK_RENDERER_ID = 'posthog-issue-detail-fallback';

/** The source display name, named once for the descriptor and the Settings page. */
export const POSTHOG_SOURCE_DISPLAY_NAME = 'PostHog';

/**
 * The source-owned Settings page a person uses to put PostHog into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution: the generic Settings catalog owns the
 * group, route and availability decision, and this source supplies one page and
 * one renderer. The page is the only production caller of the target-owned
 * `happier.triage/sources/administer-v1` Action for this source, and without it
 * every configured-instance path in this package is unreachable from the
 * product.
 */
export const POSTHOG_TRIAGE_SETTINGS_GROUP_ID = 'posthog';
export const POSTHOG_TRIAGE_SETTINGS_PAGE_ID = 'triage-sources';
export const POSTHOG_TRIAGE_SETTINGS_RENDERER_ID = 'posthog-triage-sources';
export const POSTHOG_TRIAGE_SETTINGS_ARTIFACT_ID = 'posthog-triage-sources-native';

/** The Action ids that carry the three source read roles. */
export const POSTHOG_ACTION_IDS = {
    configuration: 'posthog/configuration',
    listInstances: 'posthog/list-instances',
    scan: 'posthog/scan',
    get: 'posthog/get',
    /**
     * The source-native sampled-occurrence read. It carries no Triage role: a sampled
     * exception event is PostHog-native content the detail body reads, not a Triage
     * entry the aggregate can hold.
     */
    issueEvents: 'posthog/issue-events',
    /**
     * The source-native issue-activity read. Like the sampled read it carries no Triage
     * role, and unlike every other read here it needs the separate `activity_log:read`
     * scope, so an account may be refused this one alone.
     */
    issueActivity: 'posthog/issue-activity',
    /** Explicit warning-confirmed reread of one selected occurrence's Tier-3 fields. */
    codeVariables: 'posthog/code-variables',
} as const;

/** The credential field of the administrator-configured Personal API key pilot. */
export const POSTHOG_PERSONAL_API_KEY_FIELD_ID = 'personal-api-key';

/** The configuration field that supplies this account's exact deployment origin. */
export const POSTHOG_API_ORIGIN_FIELD_ID = 'api-origin';

/** The one authentication mode V1 implements in this plugin. */
export const POSTHOG_PERSONAL_API_KEY_MODE_ID = 'personal-api-key';
