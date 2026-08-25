import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

import { GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID, gitlabHostingProviderAdapter } from './adapter.js';
import { GITLAB_RENDER_UI_TRANSLATIONS } from './ui/renderTranslations.js';
import { GITLAB_ADDITIONAL_UI_TRANSLATIONS } from './ui/additionalTranslations.js';

import {
  GITLAB_ORIGIN_CONFIGURATION_FIELD,
  GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
  GITLAB_TOKEN_CREDENTIAL_KEY,
  gitlabConnectedAccountRuntime,
} from './auth/connectedAccountRuntime.js';
import {
  GITLAB_CONNECTED_ACCOUNT_ID,
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_NETWORK_HOST_ACCESS_ID,
  GITLAB_TRIAGE_ACTION_DECLARATIONS,
  GITLAB_TRIAGE_ACTION_IDS,
  GITLAB_TRIAGE_CONTRIBUTION_DECLARATION,
  GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID,
  GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
  GITLAB_TRIAGE_DETAIL_ARTIFACT_ID,
  GITLAB_TRIAGE_DETAIL_RENDERER_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID,
  GITLAB_TRIAGE_SETTINGS_GROUP_ID,
  GITLAB_TRIAGE_SETTINGS_PAGE_ID,
  GITLAB_TRIAGE_SETTINGS_RENDERER_ID,
} from './triage/contribution.js';
import {
  listGitlabActivityEvents,
  listGitlabChanges,
  listGitlabDiscussions,
  listGitlabNotes,
  listGitlabPipelines,
  readGitlabApprovals,
} from './triage/detailOperations.js';
import {
  getGitlabSourceEntryAction,
  listGitlabInstancesAction,
  scanGitlabSourceAction,
} from './triage/operations.js';
import {
  assignGitlabIssue,
  changeGitlabIssueLabels,
  changeGitlabMergeRequestReviewers,
  closeGitlabIssue,
  closeGitlabMergeRequest,
  markGitlabMergeRequestReady,
  mergeGitlabMergeRequest,
  reopenGitlabIssue,
  reopenGitlabMergeRequest,
  resolveGitlabMergeRequestDiscussion,
} from './triage/mutations/operations.js';

const GITLAB_ACTION_DECLARATIONS = [
  ...GITLAB_TRIAGE_ACTION_DECLARATIONS,
  ...GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS,
  ...GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS,
];

function readGitlabActionDeclaration(id: string) {
  const declaration = GITLAB_ACTION_DECLARATIONS.find((candidate) => candidate.id === id);
  if (declaration === undefined) {
    throw new TypeError(`gitlab_action_declaration_missing:${id}`);
  }
  return declaration;
}

export const GITLAB_PLUGIN = definePlugin({
  id: GITLAB_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'GitLab SCM hosting provider',
  description: 'Detects GitLab remotes and provides GitLab repository operations.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: GITLAB_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the configured GitLab SCM provider origin.',
      scope: {
        targets: [
          { kind: 'scmProviderOrigin', provider: 'gitlab' },
          { kind: 'connectedAccountOrigin', service: GITLAB_CONNECTED_ACCOUNT_ID },
        ],
        // Exactly the verbs the declared Actions consume, and no others. The
        // host revalidates the origin AND the method at dispatch and refuses an
        // ungranted verb before it reaches GitLab, so a write missing from this
        // list fails at the host authority boundary where no unit test can see
        // it. `PUT` is the merge and the state transition; `POST` is the
        // GraphQL draft transition. A verb with no declaring Action is not
        // granted for symmetry.
        methods: ['GET', 'POST', 'PUT'],
      },
    }, {
      id: 'gitlab-cli-process',
      capability: 'process',
      reason: 'Run the declared GitLab CLI for pull-request operations.',
      scope: { executables: [{ kind: 'systemTool', id: 'gitlab-cli' }] },
    }, {
      id: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact configured GitLab Connected Account for GitLab API requests.',
      scope: {
        serviceRefs: [GITLAB_CONNECTED_ACCOUNT_ID],
        // This source never asks the user to select a binding: it enumerates
        // the accounts already authorized for its purpose and materializes the
        // exact one a configured instance names.
        operations: ['use'],
        materializationKinds: ['httpHeaders'],
      },
    }],
    optional: [],
  },
  scmHostingProviders: {
    [GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID]: {
      declaration: {
        title: 'GitLab',
        description: 'GitLab.com repositories.',
        kind: 'gitlab',
        capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
      },
      runtime: { adapter: gitlabHostingProviderAdapter },
    },
  },
  systemTools: {
    'gitlab-cli': {
      title: 'GitLab CLI',
      description: 'GitLab command line client used for authenticated merge-request operations.',
      executableNames: ['glab'],
    },
  },
  connectedAccountDescriptors: {
    [GITLAB_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: 'GitLab account',
        description: 'GitLab deployment and personal access token used to read merge requests and issues.',
        authentication: {
          defaultModeId: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
          modes: [{
            id: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
            kind: 'manual',
            title: 'Personal access token',
            outcomeReconciliation: 'none',
            fields: [{
              id: GITLAB_TOKEN_CREDENTIAL_KEY,
              title: 'Personal access token',
              description: 'A GitLab personal access token. Reading needs read_api; mutations need api.',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
            configuration: {
              scope: 'account',
              // Changing the deployment is not an update of the same connection:
              // it retires the old configured instance and starts a fresh scan.
              changeBehavior: 'reconnect',
              fields: [{
                id: GITLAB_ORIGIN_CONFIGURATION_FIELD,
                title: 'GitLab URL',
                description: 'The base URL of your GitLab, for example https://gitlab.com.',
                semantic: 'connectedAccountOrigin',
                schema: { type: 'string', minLength: 8, maxLength: 2048 },
                secret: false,
                required: true,
              }],
            },
          }],
        },
      },
      runtime: gitlabConnectedAccountRuntime,
    },
  },
  actions: {
    [GITLAB_TRIAGE_ACTION_IDS.listInstances]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.listInstances),
      run: listGitlabInstancesAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.scan]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.scan),
      run: scanGitlabSourceAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.get]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.get),
      run: getGitlabSourceEntryAction,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes),
      run: listGitlabNotes,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents),
      run: listGitlabActivityEvents,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions),
      run: listGitlabDiscussions,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals),
      run: readGitlabApprovals,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines),
      run: listGitlabPipelines,
    },
    [GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges),
      run: listGitlabChanges,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge),
      run: mergeGitlabMergeRequest,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady),
      run: markGitlabMergeRequestReady,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose),
      run: closeGitlabMergeRequest,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReopen]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReopen),
      run: reopenGitlabMergeRequest,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueClose]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueClose),
      run: closeGitlabIssue,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueReopen]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueReopen),
      run: reopenGitlabIssue,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange),
      run: changeGitlabMergeRequestReviewers,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestDiscussionResolution]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestDiscussionResolution),
      run: resolveGitlabMergeRequestDiscussion,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign),
      run: assignGitlabIssue,
    },
    [GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel),
      run: changeGitlabIssueLabels,
    },
  },
  ui: {
      renderers: [{
        id: GITLAB_TRIAGE_DETAIL_RENDERER_ID,
        kind: 'reactNative',
        artifact: GITLAB_TRIAGE_DETAIL_ARTIFACT_ID,
        // The detail body reads through this plugin's own Actions, so a mount
        // without them would render an empty shell rather than a useful surface.
        requiredHostMethods: ['executeAction'],
      }, {
        id: GITLAB_TRIAGE_SETTINGS_RENDERER_ID,
        kind: 'reactNative',
        artifact: GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID,
        // The page's whole purpose is two Action invocations — this source's own
        // discovery read and the target-owned administration write.
        requiredHostMethods: ['executeAction'],
      }],
      settingsGroups: [{
        id: GITLAB_TRIAGE_SETTINGS_GROUP_ID,
        title: { key: 'plugins.gitlab.settings.group', fallback: 'GitLab' },
        icon: 'settings',
        defaultRank: 40,
      }],
      settingsPages: [{
        id: GITLAB_TRIAGE_SETTINGS_PAGE_ID,
        group: { kind: 'plugin', localId: GITLAB_TRIAGE_SETTINGS_GROUP_ID },
        title: { key: 'plugins.gitlab.settings.sources', fallback: 'PRs & Issues' },
        subtitle: {
          key: 'plugins.gitlab.settings.sources.subtitle',
          fallback: 'Choose which GitLab accounts and projects appear in PRs & Issues.',
        },
        keywords: ['gitlab', 'merge requests', 'issues', 'triage'],
        icon: 'settings',
        defaultRank: 10,
        renderer: GITLAB_TRIAGE_SETTINGS_RENDERER_ID,
      }],
      translations: [
        { locale: 'en', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["en"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["en"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PRs & Issues', 'plugins.gitlab.settings.sources.subtitle': 'Choose which GitLab accounts and projects appear in PRs & Issues.' } },
        { locale: 'ru', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["ru"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["ru"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR и задачи', 'plugins.gitlab.settings.sources.subtitle': 'Выберите учетные записи и проекты GitLab, которые будут отображаться в разделе PR и задач.' } },
        { locale: 'pl', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["pl"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["pl"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR-y i zgłoszenia', 'plugins.gitlab.settings.sources.subtitle': 'Wybierz konta i projekty GitLab wyświetlane w sekcji PR-ów i zgłoszeń.' } },
        { locale: 'es', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["es"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["es"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR e incidencias', 'plugins.gitlab.settings.sources.subtitle': 'Elige qué cuentas y proyectos de GitLab aparecen en PR e incidencias.' } },
        { locale: 'fr', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["fr"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["fr"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR et tickets', 'plugins.gitlab.settings.sources.subtitle': 'Choisissez les comptes et projets GitLab affichés dans PR et tickets.' } },
        { locale: 'it', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["it"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["it"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR e segnalazioni', 'plugins.gitlab.settings.sources.subtitle': 'Scegli gli account e i progetti GitLab da mostrare in PR e segnalazioni.' } },
        { locale: 'pt', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["pt"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["pt"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PRs e problemas', 'plugins.gitlab.settings.sources.subtitle': 'Escolha as contas e os projetos GitLab apresentados em PRs e problemas.' } },
        { locale: 'ca', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["ca"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["ca"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR i incidències', 'plugins.gitlab.settings.sources.subtitle': 'Tria els comptes i projectes de GitLab que es mostren a PR i incidències.' } },
        { locale: 'zh-Hans', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["zh-Hans"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["zh-Hans"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR 和问题', 'plugins.gitlab.settings.sources.subtitle': '选择要在 PR 和问题中显示的 GitLab 帐户和项目。' } },
        { locale: 'zh-Hant', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["zh-Hant"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["zh-Hant"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR 與問題', 'plugins.gitlab.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 GitLab 帳戶和專案。' } },
        { locale: 'ja', messages: { ...GITLAB_RENDER_UI_TRANSLATIONS["ja"], ...GITLAB_ADDITIONAL_UI_TRANSLATIONS["ja"], 'plugins.gitlab.settings.group': 'GitLab', 'plugins.gitlab.settings.sources': 'PR と課題', 'plugins.gitlab.settings.sources.subtitle': 'PR と課題に表示する GitLab アカウントとプロジェクトを選択します。' } },
      ],
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID]: GITLAB_TRIAGE_CONTRIBUTION_DECLARATION,
      },
    },
  },
});

export const PLUGIN_MANIFEST = GITLAB_PLUGIN.manifest;
