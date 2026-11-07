import { posthogDetailTabDeclaration } from './ui/detail/tabDeclarations.js';
import { POSTHOG_ACCOUNT_ACTIONS } from './accountActions.js';
/**
 * The sole PostHog plugin manifest.
 *
 * It declares exactly one Triage source contribution, native issue writes, the three read Actions that carry
 * its roles, the source-native detail reads behind its own body, the Connected
 * Account this source may materialize, the one direct-disclosure Tier-B Composer
 * reference, and the two host grants those operations need. It declares no Composer
 * attachment, control, chip, picker, region, or whole-entry reference provider:
 * `happier.triage` owns the one whole-entry attachment, and a second owner here would
 * make the aggregate ambiguous about what a row is.
 *
 * Triage-role Actions use the exact published Triage schemas. Native detail Actions
 * reuse those inputs where applicable and own only their source-private result fields.
 */

import { defineComposerReference, definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginEventAutomationSetupResultV1JsonSchema, PluginEventAutomationHistoryGapResetActionInputV1JsonSchema, PluginEventAutomationHistoryGapResetActionResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { createTriageIssueEventSourceSetupV1, TriageIssueEventSetupInputV1Schema, TriageIssueEventSourceConfigV1Schema, TriageIssueTransitionV1Schema, TRIAGE_ISSUE_EVENT_SETUP_INPUT_HINTS_V1, TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1 } from '@happier-dev/triage-sources/runtime';
import { runPosthogIssueObserver, resetPosthogIssueHistoryGap } from './source/issueObserver.js';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';

import { posthogConnectedAccountRuntime, posthogPortableAccountRuntime } from './connect/account.js';

import { POSTHOG_ACTION_IDS, POSTHOG_API_ORIGIN_FIELD_ID, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_DETAIL_ARTIFACT_ID, POSTHOG_DETAIL_FALLBACK_RENDERER_ID, POSTHOG_EVIDENCE_REFERENCE_ID, POSTHOG_SOURCE_DISPLAY_NAME, POSTHOG_TRIAGE_SETTINGS_ARTIFACT_ID, POSTHOG_TRIAGE_SETTINGS_GROUP_ID, POSTHOG_TRIAGE_SETTINGS_PAGE_ID, POSTHOG_TRIAGE_SETTINGS_RENDERER_ID, POSTHOG_DETAIL_RENDERER_ID, POSTHOG_NETWORK_HOST_ACCESS_ID, POSTHOG_PERSONAL_API_KEY_FIELD_ID, POSTHOG_PERSONAL_API_KEY_MODE_ID, POSTHOG_PLUGIN_ID, POSTHOG_SOURCE_CONTRIBUTION_ID } from './posthogContracts.js';
import { POSTHOG_ENTRY_KIND } from './source/map/entrySnapshot.js';

import { resolvePosthogEvidenceReference, searchPosthogEvidenceReferences } from './composer/reference.js';

export {
    POSTHOG_ACTION_IDS,
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_DETAIL_ARTIFACT_ID,
    POSTHOG_DETAIL_FALLBACK_RENDERER_ID,
    POSTHOG_DETAIL_RENDERER_ID,
    POSTHOG_NETWORK_HOST_ACCESS_ID,
    POSTHOG_PLUGIN_ID,
    POSTHOG_SOURCE_CONTRIBUTION_ID,
} from './posthogContracts.js';

const sources = TriageSourcesContributionProtocolV1;

/**
 * The exact deployment this account reads.
 *
 * It is non-secret configuration with `semantic: 'connectedAccountOrigin'`, which is
 * what makes the host — not this source — the owner of the normalized origin, the
 * HostAccess admission, and the account's published `connectedAccountOrigins`.
 */
const API_ORIGIN_FIELD = {
    id: POSTHOG_API_ORIGIN_FIELD_ID,
    title: { key: 'plugins.posthog.auth.origin.title', fallback: 'PostHog URL' },
    description: {
        key: 'plugins.posthog.auth.origin.description',
        fallback: 'The API origin of your PostHog deployment, for example'
            + ' https://eu.posthog.com, https://us.posthog.com, or your self-hosted URL.',
    },
    semantic: 'connectedAccountOrigin' as const,
    // Canonical origin parsing/admission is host-owned. Do not add a second URL
    // length policy at the provider declaration.
    schema: { type: 'string' as const, minLength: 1 },
    required: true as const,
    secret: false as const,
};

const PERSONAL_API_KEY_FIELD = {
    id: POSTHOG_PERSONAL_API_KEY_FIELD_ID,
    title: {
        key: 'plugins.posthog.auth.personalApiKey.title',
        fallback: 'PostHog personal API key',
    },
    description: {
        key: 'plugins.posthog.auth.personalApiKey.description',
        fallback: 'A personal API key scoped to error_tracking:read, organization:read,'
            + ' project:read and activity_log:read. The assignee picker additionally needs'
            + ' organization_member:read; issue writes need error_tracking:write.',
    },
    schema: { type: 'string' as const, minLength: 1 },
    secret: true as const,
};

/**
 * The source descriptor.
 *
 * PostHog contributes one kind. An error issue is neither a pull request nor a code
 * issue, and flattening it into either would make the aggregate misdescribe the row.
 */
const POSTHOG_SOURCE_DESCRIPTOR = {
    v: 1 as const,
    purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    // The page this source's own Settings contribution ships, so the PRs & Issues
    // surface can offer a working Configure action. A BARE local id — the target
    // qualifies it with the contributor identity the host already admitted.
    settingsPageId: POSTHOG_TRIAGE_SETTINGS_PAGE_ID,
    displayName: POSTHOG_SOURCE_DISPLAY_NAME,
    scopeUnit: { singularLabel: 'Environment', pluralLabel: 'Environments' },
    kinds: [{
        id: POSTHOG_ENTRY_KIND,
        workflowSubject: 'errorIssue' as const,
        displayName: 'Error issue',
        pluralDisplayName: 'Error issues',
        // r0.42: the Triage detail frame draws these tabs and asks this source
        // for each as a panel. Files and Checks come from the linked fix PR;
        // this source's own views follow the shared tabs.
        detailTabs: [
            { kind: 'shared' as const, id: 'overview' as const, scrollOwner: posthogDetailTabDeclaration('overview').scrollOwner },
            { kind: 'shared' as const, id: 'activity' as const, scrollOwner: posthogDetailTabDeclaration('activity').scrollOwner },
            { kind: 'source' as const, id: 'stack-trace', scrollOwner: posthogDetailTabDeclaration('stack-trace').scrollOwner, title: 'Stack trace', titleKey: 'plugins.posthog.ui.tab.stackTrace' },
            // The row's own counts are these tabs' summaries.
            { kind: 'source' as const, id: 'occurrences', scrollOwner: posthogDetailTabDeclaration('occurrences').scrollOwner, title: 'Occurrences', titleKey: 'plugins.posthog.ui.tab.occurrences', summaryFact: 'posthog/occurrences' },
            { kind: 'source' as const, id: 'affected-sessions', scrollOwner: posthogDetailTabDeclaration('affected-sessions').scrollOwner, title: 'Affected sessions', titleKey: 'plugins.posthog.ui.tab.affectedSessions', summaryFact: 'posthog/sessions' },
        ],
        // Resolve and Suppress are the issue's own actions: the frame places them in its header (its ⋯), not
        // under the story.
        detailActions: true as const,
    }],
};

/**
 * Every read reaches both the provider and the exact account, so both grants are
 * declared on all three Actions.
 *
 * Every read that carries an account also names the input leaf holding it, so the host
 * knows which credential this Action may resolve before it runs. `scan` is included:
 * its published input is a discriminated union, and the canonical Action parser
 * traverses every arm, so a binding is admitted only because both the `initial` and
 * `continuation` arms carry the same `instance` leaf. A path only one arm could reach
 * is rejected there rather than silently proving nothing.
 *
 * `listInstances` is the one read without a binding, and not by omission: its published
 * input carries no account, because discovering them is what the operation does.
 */

export const POSTHOG_PLUGIN = definePlugin({
    id: POSTHOG_PLUGIN_ID,
    version: '0.0.0',
    displayName: 'PostHog',
    description: 'Brings PostHog error issues into PRs & Issues with their own detail body.',
    brand: { iconResourceId: 'brand-icon', monochrome: true },
    resources: {
      'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
      "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
      "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
      "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
      "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
      "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
      "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
      "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
      "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
      "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
      "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
      "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
      "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
    },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    composer: {
        references: {
            [POSTHOG_EVIDENCE_REFERENCE_ID]: defineComposerReference({
                title: 'PostHog occurrence',
                icon: 'error',
                search: searchPosthogEvidenceReferences,
                resolve: resolvePosthogEvidenceReference,
            }),
        },
    },
    notifications: {
        'issue-alerts': { kind: 'plugin', title: 'Issue alerts', eventIds: ['issue-transition'] },
    },
    events: {
        'issue-transition': { declaration: {
            kind: 'event', title: 'PostHog issue changed', description: 'A watched issue opened, changed, or resolved.',
            payloadSchema: TriageIssueTransitionV1Schema.jsonSchema,
            automation: { v: 1, eligible: true, source: {
                sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                sourceConfigSchema: TriageIssueEventSourceConfigV1Schema.jsonSchema,
                setupActionRef: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.setupIssueEvent },
                historyGapResetActionRef: { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_ACTION_IDS.resetIssueEvent },
                connectedAccountPurposeBindings: [{ path: 'instance.binding.account', purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }],
            } },
        } },
    },
    accountCollections: { [TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1.id]: TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1 },
    backgroundServices: [{ declaration: { id: 'issue-observer', title: 'PostHog issue observer' }, runner: runPosthogIssueObserver }],
    hostAccess: {
        required: [{
            id: 'issue-checkpoint-storage', capability: 'storage.account',
            reason: 'Retain issue transition checkpoints for enabled source observers.', scope: { enabled: true },
        }, {
            id: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            capability: 'connectedAccounts',
            reason: 'Materialize only the exact selected PostHog Connected Account for PostHog API requests.',
            scope: {
                serviceRefs: [POSTHOG_CONNECTED_ACCOUNT_PURPOSE],
                operations: ['select', 'use'],
                materializationKinds: ['httpHeaders'],
            },
        }, {
            id: POSTHOG_NETWORK_HOST_ACCESS_ID,
            capability: 'network',
            reason: 'Read PostHog organizations, environments and Error Tracking issues, and update individual issues for the selected Connected Account.',
            scope: {
                targets: [{
                    kind: 'connectedAccountOrigin',
                    service: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
                }],
                // Error Tracking splits its planes across verbs: issue metadata is a
                // `GET` on the CRUD plane while every issue and event query is a `POST`.
                // Exact issue status/assignment writes use PATCH.
                methods: ['GET', 'POST', 'PATCH'],
                // The explicit self-hosted personal-API-key pilot is in V1 scope, and a
                // self-hosted deployment may live on a private network. Removing that
                // pilot must remove this in the same change.
                privateNetwork: true,
            },
        }],
        optional: [],
    },
    ui: {
        views: [],
        renderers: [{
            id: POSTHOG_DETAIL_RENDERER_ID,
            kind: 'reactNative',
            artifact: POSTHOG_DETAIL_ARTIFACT_ID,
            // The body materializes the entry live and reads its sampled occurrences
            // through this plugin's own Actions, so a mount without them would be an
            // empty shell rather than a useful surface.
            requiredHostMethods: ['executeAction'],
        }, {
            // Selected by the host only when the native renderer above cannot be
            // mounted, through the chain the contribution binds below. Declaring it
            // here does not place it: an unbound fallback can never be reached.
            id: POSTHOG_DETAIL_FALLBACK_RENDERER_ID,
            kind: 'declarative',
            root: {
                kind: 'text',
                text: {
                    key: 'plugins.posthog.detail.fallback.body',
                    fallback: 'PostHog issue details are unavailable on this surface.',
                },
            },
        }, {
            id: POSTHOG_TRIAGE_SETTINGS_RENDERER_ID,
            kind: 'reactNative',
            artifact: POSTHOG_TRIAGE_SETTINGS_ARTIFACT_ID,
            // The page's whole purpose is two Action invocations — this source's own
            // discovery read and the target-owned administration write.
            requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
        }],
        settingsGroups: [{
            id: POSTHOG_TRIAGE_SETTINGS_GROUP_ID,
            title: { key: 'plugins.posthog.settings.group', fallback: 'PostHog' },
            icon: 'settings',
            defaultRank: 40,
        }],
        settingsPages: [{
            id: POSTHOG_TRIAGE_SETTINGS_PAGE_ID,
            group: { kind: 'plugin', localId: POSTHOG_TRIAGE_SETTINGS_GROUP_ID },
            title: { key: 'plugins.posthog.settings.sources', fallback: 'PRs & Issues' },
            subtitle: {
                key: 'plugins.posthog.settings.sources.subtitle',
                fallback: 'Choose which PostHog organizations and projects appear in PRs & Issues.',
            },
            keywords: ['posthog', 'errors', 'issues', 'triage'],
            icon: 'settings',
            defaultRank: 10,
            renderer: POSTHOG_TRIAGE_SETTINGS_RENDERER_ID,
        }],
        translations: [
          { locale: "en", resourceId: "i18n-en" },
          { locale: "ru", resourceId: "i18n-ru" },
          { locale: "pl", resourceId: "i18n-pl" },
          { locale: "es", resourceId: "i18n-es" },
          { locale: "fr", resourceId: "i18n-fr" },
          { locale: "it", resourceId: "i18n-it" },
          { locale: "pt", resourceId: "i18n-pt" },
          { locale: "de", resourceId: "i18n-de" },
          { locale: "ca", resourceId: "i18n-ca" },
          { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
          { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
          { locale: "ja", resourceId: "i18n-ja" },
        ],
    },
    actions: {
        ...POSTHOG_ACCOUNT_ACTIONS,
        [POSTHOG_ACTION_IDS.resetIssueEvent]: {
            title: 'Check PostHog issue baseline', surfaces: ['plugin'], dangerLevel: 'safe',
            inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
            resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
            run: resetPosthogIssueHistoryGap,
        },
        [POSTHOG_ACTION_IDS.setupIssueEvent]: {
            title: 'Watch PostHog issues',
            description: 'Prepares an existing configured source for issue alerts without changing it.',
            surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe',
            inputSchema: TriageIssueEventSetupInputV1Schema.jsonSchema,
            inputHints: TRIAGE_ISSUE_EVENT_SETUP_INPUT_HINTS_V1,
            resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, TriageIssueEventSourceConfigV1Schema.jsonSchema),
            run: createTriageIssueEventSourceSetupV1({ pluginId: POSTHOG_PLUGIN_ID, sourceLocalId: POSTHOG_SOURCE_CONTRIBUTION_ID, displayName: 'PostHog' }),
        }
    },
    connectedAccountDescriptors: {
        [POSTHOG_CONNECTED_ACCOUNT_PURPOSE]: {
            declaration: {
                title: { key: 'plugins.posthog.account.title', fallback: 'PostHog account' },
                description: {
                    key: 'plugins.posthog.account.description',
                    fallback: 'PostHog deployment and personal API key used to read'
                        + ' organizations, environments and Error Tracking issues.',
                },
                authentication: {
                    account: { artifactId: 'posthog-account-runtime', exportName: 'activate' },
                    defaultModeId: POSTHOG_PERSONAL_API_KEY_MODE_ID,
                    modes: [{
                        id: POSTHOG_PERSONAL_API_KEY_MODE_ID,
                        kind: 'manual',
                        setup: {
                            url: 'https://posthog.com/docs/api/personal-api-keys',
                            checklist: ['Open Personal API keys in the account settings of the PostHog deployment you will connect.', 'Create a personal API key with the scopes needed for the projects and actions you want to use.', 'Copy the key and enter the matching deployment URL here.'],
                            createKeyTitle: 'Read PostHog API key instructions',
                        },
                        credentialOrigin: 'authentication',
                        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
                        title: {
                            key: 'plugins.posthog.auth.personalApiKey.mode',
                            fallback: 'Personal API key',
                        },
                        outcomeReconciliation: 'none',
                        fields: [PERSONAL_API_KEY_FIELD],
                        configuration: {
                            scope: 'account',
                            // Changing the deployment is not an update of the same
                            // connection: it is a different identity, so it retires the
                            // configured instance rather than aliasing it.
                            changeBehavior: 'reconnect',
                            fields: [API_ORIGIN_FIELD],
                        },
                    }],
                },
            },
            runtime: posthogConnectedAccountRuntime, accountRuntime: posthogPortableAccountRuntime,
        },
    },
    contributesTo: {
        [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
            [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
                [POSTHOG_SOURCE_CONTRIBUTION_ID]: sources.contribute({
                    descriptor: POSTHOG_SOURCE_DESCRIPTOR,
                    operations: {
                        listInstances: sources.operations.listInstances
                            .bind(POSTHOG_ACTION_IDS.listInstances),
                        listScopeUnits: sources.operations.listScopeUnits.bind(POSTHOG_ACTION_IDS.listScopeUnits),
                        scan: sources.operations.scan.bind(POSTHOG_ACTION_IDS.scan),
                        get: sources.operations.get.bind(POSTHOG_ACTION_IDS.get),
                    },
                    surfaces: {
                        detail: {
                            renderer: POSTHOG_DETAIL_RENDERER_ID,
                            fallbackRenderers: [POSTHOG_DETAIL_FALLBACK_RENDERER_ID],
                        },
                    },
                }),
            },
        },
    },
});

/** The sole PostHog plugin manifest. */
export const PLUGIN_MANIFEST = POSTHOG_PLUGIN.manifest;
export const collectionMigrations = POSTHOG_PLUGIN.collectionMigrations;
