import type { SupportedLanguage } from '../_all';

/**
 * Add a platform target: link an Environment to a project the person already has on a hosting platform
 * (from the plugins' own deployment targets), from the Environment page and the new-environment draft.
 */
export type DeploymentPlatformLinkCopy = Readonly<{
  detachLead: (params: { name: string; platform: string }) => string;
  detachBody: (params: { platform: string }) => string;
  removalTitle: (params: { resource: string }) => string;
  removalLead: (params: { resource: string; platform: string }) => string;
  keepTitle: (params: { platform: string }) => string;
  keepBody: (params: { resource: string; platform: string }) => string;
  keepBodyData: (params: { resource: string; platform: string }) => string;
  deleteTitle: (params: { platform: string }) => string;
  deleteBody: (params: { resource: string; platform: string }) => string;
  deleteConsequence: (params: { resource: string; platform: string }) => string;
  typeToDelete: (params: { resource: string }) => string;
  confirmDelete: (params: { resource: string }) => string;
  confirmDeleteWithEnvironment: (params: { name: string; resource: string }) => string;
  createOnMachine: string;
  finishLinkingOnMachine: string;
  openProvider: string;
  recoveryUnavailable: string;
  modeTitle: string;
  modeExisting: string;
  modeCreate: string;
  createNew: string;
  create: (params: { platform: string }) => string;
  createConsequences: string;
  gitCreateProductionPush: (params: { resourceName: string; repository: string; productionBranch: string }) => string;
  gitCreateFollowsBranch: (params: { resourceName: string; repository: string; productionBranch: string; platform: string }) => string;
  reviewMissing: (params: { field: string }) => string;
  provisioned: string;
  created: string;
  branchSet: (params: { branch: string }) => string;
  branchDefaultKept: (params: { branch: string; requestedBranch: string }) => string;
  branchUnconfirmed: (params: { requestedBranch: string }) => string;
  finishLinking: string;
  outcomeUnknown: string;
  outcomeUnknownBody: string;
  duplicate: string;
  useExisting: string;
  chooseAnother: string;
  accessTitle: string;
  deploysUse: (params: { platform: string }) => string;
  personalAccessDependency: string;
  connectionPersonalNote: string;
  connectionTeamNote: string;
  teamAccessDependency: string;
  providerAccount: string;
  providerProject: string;
  providerScope: string;
  title: (params: { name: string }) => string;
  lead: string;
  add: string;
  usePlatform: string;
  platform: string;
  sourceMethod: string;
  gitIntegration: string;
  upload: string;
  gitIntegrationBody: string;
  uploadBody: string;
  sourceManifest: string;
  providerBuild: string;
  controllerBuild: string;
  buildImage: string;
  buildToolchain: string;
  buildOutputManifest: string;
  loading: string;
  failed: string;
  empty: string;
  emptyBody: string;
  check: string;
  checkAgain: string;
  link: (params: { platform: string }) => string;
  ready: string;
  needsGit: string;
  needsGitBody: string;
  repositoryRequired: string;
  repositoryRequiredBody: string;
  grant: string;
  refused: string;
  linkRefused: string;
  onMachine: string;
  platformLater: string;
  deploysFrom: string;
  deploysFromBody: string;
  onPlatformTitle: (params: { platform: string }) => string;
  onPlatformBody: string;
  platformBuilds: string;
  managersOnly: string;
  refusedRemedy: string;
  connectionRequiresPermission: (params: { permission: string }) => string;
  nothingDeployedBody: string;
  deployNoPlatform: string;
  connectTitle: (params: { platform: string }) => string;
  connectBody: (params: { platform: string }) => string;
  connectAction: (params: { platform: string }) => string;
  choicesFailed: (params: { platform: string }) => string;
  choicesFailedBody: string;
  connection: string;
  hostNeedsSetup: string;
  hostSetupBody: string;
  hostSetupAction: (params: { machine: string }) => string;
  hostReviewShort: string;
  hostUnchecked: string;
  hostUncheckedBody: (params: { machine: string }) => string;
}>;

export const deploymentPlatformLinkTranslations = {
  en: {
    detachLead: ({ name, platform }) => `Unlink ${name} from Happier and leave it on ${platform}.`,
    detachBody: ({ platform }) => `The workload keeps running on ${platform}, with its data and ongoing costs. To stop or delete it, do so in ${platform}.`,
    removalTitle: ({ resource }) => `Unlink or delete ${resource}`,
    removalLead: ({ resource, platform }) => `${resource} runs on ${platform}. Keep it there, or delete it at ${platform}.`,
    keepTitle: ({ platform }) => `Keep it on ${platform}`,
    keepBody: ({ resource, platform }) => `${resource} keeps running on ${platform} with its data and costs. Happier stops deploying to it.`,
    keepBodyData: ({ resource, platform }) => `${resource} stays on ${platform} with its data and costs. Happier stops managing it.`,
    deleteTitle: ({ platform }) => `Delete at ${platform}`,
    deleteBody: ({ resource, platform }) => `${platform} deletes ${resource}. This can’t be undone.`,
    deleteConsequence: ({ resource, platform }) => `Delete ${resource} at ${platform}?`,
    typeToDelete: ({ resource }) => `Type ${resource} to delete it`,
    confirmDelete: ({ resource }) => `Delete ${resource}`,
    confirmDeleteWithEnvironment: ({ name, resource }) => `Delete ${name} and ${resource}`,
    createOnMachine: "Create on",
    finishLinkingOnMachine: "Finish linking on",
    openProvider: "Open in provider",
    recoveryUnavailable: "Creation result is unavailable",
    modeTitle: "Start from",
    modeExisting: "Existing",
    modeCreate: "New",
    createNew: "Create new",
    create: ({ platform }) => `Create and link ${platform}`,
    createConsequences: `Creates a resource. Provider charges may apply.`,
    gitCreateProductionPush: ({ resourceName, repository, productionBranch }) => `Create service ${resourceName} from ${repository} on branch ${productionBranch}. Pushes to the production branch deploy Production.`,
    gitCreateFollowsBranch: ({ resourceName, repository, productionBranch, platform }) => `Create service ${resourceName} from ${repository} on branch ${productionBranch}. ${platform} builds the latest commit on that branch and redeploys when it changes.`,
    reviewMissing: ({ field }) => `Complete ${field} to review.`,
    provisioned: "Resource created; linking is incomplete",
    created: "Project created and linked",
    branchSet: ({ branch }) => `Production branch: ${branch}.`,
    branchDefaultKept: ({ branch, requestedBranch }) => `Production branch remains ${branch}. Could not set ${requestedBranch}; change it in the provider.`,
    branchUnconfirmed: ({ requestedBranch }) => `Update to ${requestedBranch} is unconfirmed. The provider may still use the repository’s default branch; check it in the provider.`,
    finishLinking: "Finish linking",
    outcomeUnknown: "The provider has not confirmed whether creation finished",
    outcomeUnknownBody: "Check the provider before choosing another resource. Happier will not create it again.",
    duplicate: "This provider scope is already linked",
    useExisting: "Use existing Environment",
    chooseAnother: "Choose another scope",
    accessTitle: "Deployment access",
    deploysUse: ({ platform }) => `Deploys use this ${platform} connection`,
    personalAccessDependency: "This personal connection must remain available for deployments to work. Removing it or losing provider access stops future deployments.",
    connectionPersonalNote: "Yours · deploys stop if you remove it or lose access",
    connectionTeamNote: "Your Team’s · deploys stop if the Team removes it or loses access",
    teamAccessDependency: "Deployments depend on this Team credential remaining available and retaining provider access.",
    providerAccount: "Provider account or team",
    providerProject: "Provider project",
    providerScope: "Provider environment",
    sourceManifest: "Source manifest",
    providerBuild: "Build at the platform",
    controllerBuild: "Build on the controller",
    buildImage: "Build container",
    buildToolchain: "Build toolchain",
    buildOutputManifest: "Build output manifest",
    sourceMethod: "Deploy method",
    gitIntegration: "Git integration",
    upload: "Upload",
    gitIntegrationBody: "The platform reads the reviewed commit from its connected repository.",
    uploadBody: "Happier sends the reviewed commit through the controller, without provider Git access.",
    title: ({ name }) => `Deploy ${name} to a platform`,
    lead: 'Link a project you already have on a hosting platform. Linking changes nothing there; the next Deploy does.',
    add: 'Add platform',
    usePlatform: 'Use a platform',
    platform: 'Platform',
    loading: 'Finding platforms…',
    failed: 'Couldn’t load platforms',
    empty: 'No platform is turned on',
    emptyBody: 'Turn on a deployment plugin in Plugins to link a platform.',
    check: 'Check',
    checkAgain: 'Check again',
    link: ({ platform }) => `Link ${platform}`,
    ready: 'Ready to link',
    needsGit: 'This project can’t see your repository yet',
    needsGitBody: 'Give it access, then check again.',
    repositoryRequired: 'This Source needs a repository',
    repositoryRequiredBody: 'Connect a repository to this Source, then check again.',
    grant: 'Give access',
    refused: 'Couldn’t check this project',
    linkRefused: 'Couldn’t link this project',
    onMachine: 'A Machine',
    platformLater: 'You choose the platform project right after you create it.',
    deploysFrom: 'Deploys from',
    deploysFromBody: "Happier deploys to the platform from this Machine.",
    onPlatformTitle: ({ platform }) => `On ${platform}`,
    // The step's description already says that linking deploys nothing (one message per state, DESIGN-ACCEPT C2).
    onPlatformBody: 'Pick the account, then the project.',
    platformBuilds: 'The platform builds this project’s repository at the branch you choose.',
    managersOnly: 'Only managers of this environment can link a platform.',
    refusedRemedy: 'Check the account and project you chose, then check again.',
    connectionRequiresPermission: ({ permission }) => `Add ${permission} to the connected token, then reconnect.`,
    nothingDeployedBody: 'The first deploy builds this branch on the platform you link.',
    deployNoPlatform: 'This environment has no platform project to deploy to yet.',
    connectTitle: ({ platform }) => `Connect ${platform} to deploy here`,
    connectBody: ({ platform }) => `Happier links this environment to a ${platform} project, and checks what your token can do before it links and tells you what’s missing.`,
    connectAction: ({ platform }) => `Add a ${platform} token`,
    choicesFailed: ({ platform }) => `Couldn’t read your ${platform} choices`,
    choicesFailedBody: "Check that the connection can see your projects, then retry.",
    connection: "Connection",
    hostNeedsSetup: 'This Machine isn’t set up to host deploys yet',
    hostSetupBody: "You review every change before anything runs. Saving this environment can wait until then.",
    hostSetupAction: ({ machine }) => `Set up ${machine}`,
    hostReviewShort: 'Review setup',
    hostUnchecked: 'Couldn’t check whether this Machine can host deploys',
    hostUncheckedBody: ({ machine }) => `Review setup opens ${machine}’s setup, where Happier checks it can build and run apps.`,
  },
} satisfies Pick<Record<SupportedLanguage, DeploymentPlatformLinkCopy>, 'en'>;
