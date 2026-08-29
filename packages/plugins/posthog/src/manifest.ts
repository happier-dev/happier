/**
 * The sole PostHog plugin manifest.
 *
 * It declares exactly one Triage source contribution, the three read Actions that carry
 * its roles, the three source-native detail reads behind its own body, the Connected
 * Account this source may materialize, the one direct-disclosure Tier-B Composer
 * reference, and the two host grants those reads need. It declares no Composer
 * attachment, control, chip, picker, region, or whole-entry reference provider:
 * `happier.triage` owns the one whole-entry attachment, and a second owner here would
 * make the aggregate ambiguous about what a row is.
 *
 * Every Action's input and result schema is the exact published Triage schema rather
 * than a source-local restatement, so a drift between this manifest and the shared
 * contract fails conformance instead of admitting a source that speaks a private
 * dialect.
 */

import { defineComposerReference, definePlugin } from '@happier-dev/plugin-sdk';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import { posthogConnectedAccountRuntime } from './connect/account.js';
import {
    PosthogConfigurationDirectoryInputV1Schema,
    PosthogConfigurationDirectoryResultV1Schema,
} from './connect/configurationContract.js';
import {
    POSTHOG_ACTION_IDS,
    POSTHOG_API_ORIGIN_FIELD_ID,
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_DETAIL_ARTIFACT_ID,
    POSTHOG_DETAIL_FALLBACK_RENDERER_ID,
    POSTHOG_EVIDENCE_REFERENCE_ID,
    POSTHOG_SOURCE_DISPLAY_NAME,
    POSTHOG_TRIAGE_SETTINGS_ARTIFACT_ID,
    POSTHOG_TRIAGE_SETTINGS_GROUP_ID,
    POSTHOG_TRIAGE_SETTINGS_PAGE_ID,
    POSTHOG_TRIAGE_SETTINGS_RENDERER_ID,
    POSTHOG_DETAIL_RENDERER_ID,
    POSTHOG_NETWORK_HOST_ACCESS_ID,
    POSTHOG_PERSONAL_API_KEY_FIELD_ID,
    POSTHOG_PERSONAL_API_KEY_MODE_ID,
    POSTHOG_PLUGIN_ID,
    POSTHOG_SOURCE_CONTRIBUTION_ID,
} from './posthogContracts.js';
import { POSTHOG_ENTRY_KIND } from './source/map/entrySnapshot.js';
import { POSTHOG_UI_TRANSLATIONS } from './ui/translations.js';
import {
    PosthogIssueActivityInputV1Schema,
    PosthogIssueActivityResultV1Schema,
} from './source/detail/issueActivityContract.js';
import {
    PosthogSampledEventsInputV1Schema,
    PosthogSampledEventsResultV1Schema,
} from './source/detail/issueEventsContract.js';
import {
    PosthogCodeVariablesInputV1Schema,
    PosthogCodeVariablesResultV1Schema,
} from './source/detail/codeVariablesContract.js';
import {
    getPosthogSourceEntry,
    listPosthogInstances,
    readPosthogActivity,
    readPosthogConfigurationDirectory,
    readPosthogCodeVariablesForIssue,
    readPosthogSampledEvents,
    scanPosthogSource,
} from './source/operations.js';
import {
    resolvePosthogEvidenceReference,
    searchPosthogEvidenceReferences,
} from './composer/reference.js';

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
            + ' project:read and activity_log:read.',
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
    kinds: [{
        id: POSTHOG_ENTRY_KIND,
        workflowSubject: 'errorIssue' as const,
        displayName: 'Error issue',
        pluralDisplayName: 'Error issues',
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
const READ_HOST_ACCESS = [POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_NETWORK_HOST_ACCESS_ID];
const INSTANCE_ACCOUNT_BINDINGS = [{
    path: 'instance.binding.account',
    purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
}];

export const POSTHOG_PLUGIN = definePlugin({
    id: POSTHOG_PLUGIN_ID,
    version: '0.0.0',
    displayName: 'PostHog',
    description: 'Brings PostHog error issues into PRs & Issues with their own detail body.',
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1 },
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
    hostAccess: {
        required: [{
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
            reason: 'Read PostHog organizations, environments and Error Tracking issues for the selected Connected Account.',
            scope: {
                targets: [{
                    kind: 'connectedAccountOrigin',
                    service: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
                }],
                // Error Tracking splits its planes across verbs: issue metadata is a
                // `GET` on the CRUD plane while every issue and event query is a `POST`.
                // V1 is read-only and requests no write scope.
                methods: ['GET', 'POST'],
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
            requiredHostMethods: ['executeAction'],
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
        translations: [{
            locale: 'en',
            messages: {
                ...POSTHOG_UI_TRANSLATIONS.en,
                'plugins.posthog.settings.group': 'PostHog',
                'plugins.posthog.settings.sources': 'PRs & Issues',
                'plugins.posthog.settings.sources.subtitle':
                    'Choose which PostHog organizations and projects appear in PRs & Issues.',
            },
        }, {
            locale: 'ru', messages: { ...POSTHOG_UI_TRANSLATIONS.ru, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR и задачи', 'plugins.posthog.settings.sources.subtitle': 'Выберите организации и проекты PostHog, которые будут отображаться в разделе PR и задач.' },
        }, {
            locale: 'pl', messages: { ...POSTHOG_UI_TRANSLATIONS.pl, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR-y i zgłoszenia', 'plugins.posthog.settings.sources.subtitle': 'Wybierz organizacje i projekty PostHog wyświetlane w sekcji PR-ów i zgłoszeń.' },
        }, {
            locale: 'es', messages: { ...POSTHOG_UI_TRANSLATIONS.es, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR e incidencias', 'plugins.posthog.settings.sources.subtitle': 'Elige qué organizaciones y proyectos de PostHog aparecen en PR e incidencias.' },
        }, {
            locale: 'fr', messages: { ...POSTHOG_UI_TRANSLATIONS.fr, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR et tickets', 'plugins.posthog.settings.sources.subtitle': 'Choisissez les organisations et projets PostHog affichés dans PR et tickets.' },
        }, {
            locale: 'it', messages: { ...POSTHOG_UI_TRANSLATIONS.it, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR e segnalazioni', 'plugins.posthog.settings.sources.subtitle': 'Scegli le organizzazioni e i progetti PostHog da mostrare in PR e segnalazioni.' },
        }, {
            locale: 'pt', messages: { ...POSTHOG_UI_TRANSLATIONS.pt, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PRs e problemas', 'plugins.posthog.settings.sources.subtitle': 'Escolha as organizações e os projetos PostHog apresentados em PRs e problemas.' },
        }, {
            locale: 'de', messages: { ...POSTHOG_UI_TRANSLATIONS.de, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PRs & Tickets', 'plugins.posthog.settings.sources.subtitle': 'Wähle aus, welche PostHog-Organisationen und -Projekte unter PRs & Tickets angezeigt werden.' },
        }, {
            locale: 'ca', messages: { ...POSTHOG_UI_TRANSLATIONS.ca, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR i incidències', 'plugins.posthog.settings.sources.subtitle': 'Tria les organitzacions i els projectes de PostHog que es mostren a PR i incidències.' },
        }, {
            locale: 'zh-Hans', messages: { ...POSTHOG_UI_TRANSLATIONS['zh-Hans'], 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR 和问题', 'plugins.posthog.settings.sources.subtitle': '选择要在 PR 和问题中显示的 PostHog 组织和项目。' },
        }, {
            locale: 'zh-Hant', messages: { ...POSTHOG_UI_TRANSLATIONS['zh-Hant'], 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR 與問題', 'plugins.posthog.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 PostHog 組織和專案。' },
        }, {
            locale: 'ja', messages: { ...POSTHOG_UI_TRANSLATIONS.ja, 'plugins.posthog.settings.group': 'PostHog', 'plugins.posthog.settings.sources': 'PR と課題', 'plugins.posthog.settings.sources.subtitle': 'PR と課題に表示する PostHog の組織とプロジェクトを選択します。' },
        }],
    },
    actions: {
        [POSTHOG_ACTION_IDS.configuration]: {
            title: 'Configure PostHog error issues',
            execution: { target: 'daemon' },
            description: 'Reads one user-requested page of PostHog organizations or environments.',
            scopes: ['global'],
            // The explicit empty list is the canonical mounted-only placement:
            // only the settings page this plugin itself mounts invokes it.
            surfaces: ['ui'],
            placementBindings: [],
            dangerLevel: 'safe',
            inputSchema: PosthogConfigurationDirectoryInputV1Schema.jsonSchema,
            resultSchema: PosthogConfigurationDirectoryResultV1Schema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            connectedAccountPurposeBindings: [{
                path: 'binding.account',
                purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            }],
            run: readPosthogConfigurationDirectory,
        },
        [POSTHOG_ACTION_IDS.listInstances]: {
            title: 'Discover PostHog organizations',
            execution: { target: 'daemon' },
            description: 'Lists the PostHog organizations each connected PostHog account can reach.',
            scopes: ['global'],
            surfaces: sources.operations.listInstances.declaration.surfaces,
            // Mounted-only placement. `plugin` stays because the Triage daemon
            // consumes it and `ui` because this source's own mounted surfaces
            // hold present-user authority; the explicit empty list only
            // withdraws the Action from global placement discovery — it
            // disables no invocation.
            placementBindings: [],
            dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
            inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
            resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            run: listPosthogInstances,
        },
        [POSTHOG_ACTION_IDS.scan]: {
            title: 'Scan PostHog error issues',
            execution: { target: 'daemon' },
            description: 'Reads one page of the configured PostHog error-issue walk.',
            scopes: ['global'],
            surfaces: sources.operations.scan.declaration.surfaces,
            dangerLevel: sources.operations.scan.declaration.dangerLevel,
            inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
            resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: scanPosthogSource,
        },
        [POSTHOG_ACTION_IDS.issueEvents]: {
            title: 'Read sampled PostHog occurrences',
            execution: { target: 'daemon' },
            description: 'Reads one bounded page of sampled exception events for one PostHog issue.',
            scopes: ['global'],
            // Only the source's own mounted detail body invokes this native read,
            // through the mounted Plugin UI host — present-user authority. The
            // explicit empty list keeps global placement discovery from offering
            // it a destination while the mounted invocation stays untouched.
            surfaces: ['ui'],
            placementBindings: [],
            dangerLevel: 'safe',
            inputSchema: PosthogSampledEventsInputV1Schema.jsonSchema,
            resultSchema: PosthogSampledEventsResultV1Schema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: readPosthogSampledEvents,
        },
        [POSTHOG_ACTION_IDS.issueActivity]: {
            title: 'Read PostHog issue activity',
            execution: { target: 'daemon' },
            description: 'Reads one page of the recorded activity for one PostHog issue.',
            scopes: ['global'],
            surfaces: ['ui'],
            placementBindings: [],
            dangerLevel: 'safe',
            inputSchema: PosthogIssueActivityInputV1Schema.jsonSchema,
            resultSchema: PosthogIssueActivityResultV1Schema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: readPosthogActivity,
        },
        [POSTHOG_ACTION_IDS.codeVariables]: {
            title: 'Reveal captured PostHog code variables',
            execution: { target: 'daemon' },
            description: 'Rereads one selected occurrence and returns its captured variables after confirmation.',
            scopes: ['global'],
            surfaces: ['ui'],
            placementBindings: [],
            dangerLevel: 'safe',
            inputSchema: PosthogCodeVariablesInputV1Schema.jsonSchema,
            resultSchema: PosthogCodeVariablesResultV1Schema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: readPosthogCodeVariablesForIssue,
        },
        [POSTHOG_ACTION_IDS.get]: {
            title: 'Read a PostHog error issue',
            execution: { target: 'daemon' },
            description: 'Reads one PostHog error issue authoritatively through its configured environment.',
            scopes: ['global'],
            surfaces: sources.operations.get.declaration.surfaces,
            // Mounted-only placement. `plugin` stays because the Triage daemon
            // consumes it and `ui` because this source's own mounted surfaces
            // hold present-user authority; the explicit empty list only
            // withdraws the Action from global placement discovery — it
            // disables no invocation.
            placementBindings: [],
            dangerLevel: sources.operations.get.declaration.dangerLevel,
            inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
            resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
            hostAccess: READ_HOST_ACCESS,
            connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
            run: getPosthogSourceEntry,
        },
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
                    defaultModeId: POSTHOG_PERSONAL_API_KEY_MODE_ID,
                    modes: [{
                        id: POSTHOG_PERSONAL_API_KEY_MODE_ID,
                        kind: 'manual',
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
            runtime: posthogConnectedAccountRuntime,
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
