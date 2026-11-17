import type { SupportedLanguage } from '../_all';

export type DeploymentCopyTranslations = Readonly<{
  menu: string;
  name: (params: { name: string }) => string;
  preparePrompt: (params: { name: string; sourceId: string; environmentId: string }) => string;
  title: string;
  description: string;
  bindings: string;
  same: string;
  choose: string;
  omit: string;
  include: string;
  domainsStay: string;
  dataTitle: string;
  dataOmit: string;
  dataOmitHint: string;
  dataRestoreUnavailable: string;
  dataConnections: string;
  dataConnectionsHint: string;
  dataConnectionsUnavailable: string;
  dataReuse: string;
  dataReuseHint: string;
  dataEmpty: string;
  dataEmptyHint: string;
  dataEmptyUnavailable: string;
  dataRestore: string;
  dataRestoreHint: string;
  prepareTitle: string;
  prepareBody: string;
  refresh: string;
  permission: string;
  machine: string;
  repository: string;
  unsupported: string;
  retry: string;
}>;

export const deploymentCopyTranslations = {
  "en": {
    name: ({ name }) => `${name} copy`,
    preparePrompt: ({ name, sourceId, environmentId }) => `Prepare deployment for Environment ${name} (${environmentId}), Project Source ${sourceId}. Inspect its repository and instructions. Propose a Dockerfile, compose.yaml and health check in a pull request for me to review. Do not merge or deploy.`,
    menu: "Duplicate environment…",
    title: "Duplicate environment",
    description: "Copies the deployment definition. Choose the references to keep; nothing deploys until you choose to deploy.",
    bindings: "What comes along",
    same: "Same reference",
    choose: "Choose another…",
    omit: "Leave empty",
    include: "Include",
    domainsStay: "Domains stay with the source: an address belongs to one environment.",
    dataTitle: "Data",
    dataOmit: "Don’t attach",
    dataOmitHint: "Creates this environment without this data attachment.",
    dataRestoreUnavailable: "Restoring a backup while duplicating is not available for this data.",
    dataConnections: "Shared connections",
    dataConnectionsHint: "Choose the saved connections this copy will use. The database stays attached to the source environment.",
    dataConnectionsUnavailable: "No saved connection variables are selected. Select one above, or choose another data option.",
    dataReuse: "Reuse",
    dataReuseHint: "Both environments use the same data.",
    dataEmpty: "Start empty",
    dataEmptyHint: "Attaches new, empty data. Configure its connections after creating the environment.",
    dataEmptyUnavailable: "This provider does not support creating an empty database.",
    dataRestore: "Restore latest backup",
    dataRestoreHint: "A new copy from the source’s latest backup.",
    prepareTitle: "No compose.yaml · ask an agent",
    prepareBody: "Open Start to ask an agent for a Dockerfile, compose.yaml and a health check in a pull request you review.",
    refresh: "These details are out of date. Refresh the Environment, review its latest settings, then try again.",
    permission: "Your access does not allow this operation. Ask an Environment manager for access, then try again.",
    machine: "The controller Machine is unavailable. Bring the controller Machine online, then try again.",
    repository: "No repository checkout is selected. Choose a repository checkout in Start and prepare it before deploying.",
    unsupported: "This target cannot perform this operation. Choose a supported target or change the selection.",
    retry: "The operation was refused. Check the reason, adjust the selection and try again.",
  },
} satisfies Pick<Record<SupportedLanguage, DeploymentCopyTranslations>, 'en'>;
