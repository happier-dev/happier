import { deploymentOperationalTranslations, type DeploymentOperationalTranslations } from './deploymentOperationalTranslations';
import type { SupportedLanguage } from '../_all';

const databaseAccessCopy = {
  title: 'Database access',
  inherited: 'Uses the template Environment’s database access',
  editors: 'Who can edit database rows',
  agents: 'Agents',
  openSettings: 'Open Environment settings',
  askManager: 'Only an Environment manager can change access.',
  youManage: 'You manage this Environment, so you can change who edits.',
  backup: {
    action: 'Last successful backup',
    empty: 'No successful backup yet.',
    unavailable: 'Backup history is unavailable.',
  },
  setup: {
    ownBody: 'Set up the database’s limited write login. Your changes stay in review.',
    managedBody: 'Choose the Saved Secret for this target’s direct database connection. Your changes stay in review.',
    managedSelected: 'Save the selected direct connection. Your changes stay in review.',
    chooseSecret: 'Choose a Saved Secret',
    changeSecret: 'Change Saved Secret',
    createRole: 'Set up write login',
    bindConnection: 'Save write connection',
    manager: 'Ask an Environment manager to set up database writes.',
    unavailable: 'Database write setup is unavailable.',
    writer: 'Database write login',
    ready: 'Database writes are set up. Apply again when you’re ready.',
  },
  off: 'Off',
  levels: {
    none: 'None',
    read: 'Read',
    readWriteAsk: 'Read and write (asks first)',
    readWriteNoApproval: 'Read and write (no approval)',
  },
};

/** English fallback for reviewed fleet membership, pending translation review. */
export const fleetCopy = {
  title: 'Manage servers', add: 'Add a server', remove: 'Remove server',
  sourceUnavailable: 'Serving version unavailable',
  sourceUnavailableBody: 'Wait for the serving deployment to load, then reopen this review.',
  noDestination: 'No other server is connected',
  noDestinationBody: 'Connect another machine to this Home, then reopen this review.',
  lastServer: 'This is the last server. Use Stop and remove on the environment to remove its whole target.',
  firstAddBody: 'Add the server to this environment. Nothing starts until you deploy.',
  addBody: 'The new server joins the version already serving. Existing servers keep running. Choose how traffic reaches the fleet; the run checks its network and ingress setup.',
  removeBody: 'Stop sending traffic to this server, then stop its services and remove it from this environment. Other servers keep serving. If draining fails, the server stays in the fleet.',
};

/** English fallback until reviewed translations are supplied for this new repository flow. */
export const moveToRepositoryCopy = {
  title: 'Move to repository',
  createRepository: 'Create a repository',
  chooseDestination: 'Choose a folder',
  newRepository: 'New repository',
  newRepositoryBody: 'Create an empty repository on your Git host for this definition.',
  create: 'Create…',
  destination: 'Folder',
  choose: 'Choose…',
  changes: 'File changes',
  changesBody: 'See exactly what the pull request will add before it opens.',
  previewShort: 'Preview',
  pullRequestRow: 'Pull request',
  finishMove: 'Finish the move',
  mergedVersion: 'Merged version',
  useIt: 'Use it',
  repositoryAddress: 'Repository URL',
  chooseRepository: 'Choose repository',
  existingPullRequest: 'Existing pull request URL',
  continueExisting: 'Continue an existing pull request',
  body: 'Manage this definition in Git. It stays stored in Happier until the pull request is merged and you continue.',
  workspace: 'Checkout',
  workspacePlaceholder: 'Choose a checkout',
  workspaceMissing: 'Open a checkout of this project to continue.',
  managedCheckoutUnavailable: 'Moving a definition requires a checkout on a connected Machine. Open the project there to continue.',
  sourceLoading: 'Loading project repository…',
  sourceFailed: 'Could not read the project repository',
  refresh: 'Read checkout',
  baseMissing: 'Read the checkout to choose its current branch and commit.',
  path: 'Compose path',
  preview: 'Preview file changes',
  sharedPath: 'This path may also be used by other environments. Review the existing file before replacing it.',
  confirmPath: 'Use this Compose path',
  review: 'Review pull request',
  pullRequestBody: 'The stored definition is still active. Continue after this pull request is merged.',
  continue: 'Continue',
  mergedTitle: 'Review merged definition',
  mergedBody: 'Compare the current stored definition with the merged file before switching.',
  useMerged: 'Use the merged version',
  switched: 'Definition moved to repository',
  refused: 'Could not move the definition',
  checkoutOwnerRequired: 'Only the owner of this checkout’s Machine can move a definition into it. Choose a checkout on a Machine you own, or ask its owner to move it.',
  approval: 'Review required',
  approvalBody: 'Open the exact Action review to continue.',
};

/** English fallback for the new preview controls, pending translation review. */
export const previewEditorCopy = {
  addFact: 'Deployment value',
  configure: 'Configure previews',
  watcherConnect: 'Connect GitHub',
  watcherConnectReason: 'Previews read this repository’s pull requests and add a webhook so this Home hears when one opens or changes.',
  watcherAccount: 'GitHub account',
  watcherUnavailable: 'Could not read the accounts for this repository. Turn on Previews to try again.',
  nativeTemplate: 'Database template',
  nativeEmpty: 'Start empty',
  nativeEmptyBody: 'Each preview starts with a fresh database. No production data is copied; seed it separately.',
  nativeSource: 'Copy data from',
  nativeSourceEmpty: 'No readable environments',
  nativeSourceEmptyBody: 'Choose an environment with PostgreSQL and a verified backup.',
  nativeCapture: 'Restore point',
  nativeCaptureEmpty: 'No verified backups',
  nativeCaptureEmptyBody: 'Create and verify a backup in the source environment first.',
  nativeUnsupported: 'Choose a PostgreSQL template with logical backups.',
  backupPrefix: 'Backup folder prefix',
  backupIntentBody: 'Save the backup destination for new previews. The source environment is unchanged.',

  domain: 'Preview domain',
  slug: 'Template slug',
  variables: 'Preview variables',
  variablesBody: 'Variables added to each new pull request preview.',
  inherited: 'Previews inherit approvals from their template. A preview can require approval more strictly.',
  forks: 'Fork previews',
  forksOff: 'Off',
  forksApprove: 'Approve each commit',
  forksBody: 'Review every fork commit before it runs. Use a non-production Machine: untrusted code can affect other workloads on the same Machine. Forks receive no inherited secrets or data and keep the template’s approval requirements.',
  forksLoading: 'Checking the selected Machines…',
  forksProduction: 'A selected Machine runs a production environment.',
  forksUnsupported: 'This target does not support fork previews.',
  forksUnavailable: 'Could not establish the selected Machines’ workloads.',
  forksChooseMachine: 'Choose another Machine',
};

/** English fallback for restore snapshot and upload review, pending translation review. */
export const restoreExtendedCopy = {
  uploadTitle: 'From a file', upload: 'Choose backup file', uploading: 'Uploading backup…',
  uploadBody: 'Upload the backup to this Machine, then check its contents before replacing data.',
  uploadDatabasePlaceholder: 'Database name',
  uploaded: 'Uploaded backup', volume: 'Named volume', snapshot: 'Take a Machine snapshot first',
  coverage: 'Snapshot coverage', coverageValue: ({ root, volumes }: { root: string; volumes: string }) => `Root disk: ${root}. Attached volumes: ${volumes}.`,
  billing: 'Provider billing', priceUnknown: 'Billed by the provider; price not supplied',
  consistency: 'Snapshot consistency', consistencyRunning: 'Machine running', consistencyStopped: 'Machine stopped', consistencyUnknown: 'Machine state unknown', noQuiesce: 'Applications are not quiesced',
  unavailable: 'Snapshot is unavailable because this Environment’s data runs on another Engine.',
  stopped: 'Machine snapshot not confirmed',
  stoppedBody: 'Data has not been replaced. Stop here, or review continuing without a confirmed Machine snapshot.',
  continueWithoutSnapshot: 'Continue without snapshot',
};

/** Environment → Settings (Backups destination and keep counts, Checks): copy added by DEPLOY-COMPOSE-1107 lane L-D. */
export type DeploymentSettingsTranslations = Readonly<{
  databaseAccess: typeof databaseAccessCopy;
  fleet: typeof fleetCopy;
  moveToRepository: typeof moveToRepositoryCopy;
  previewEditor: typeof previewEditorCopy;
  restoreExtended: typeof restoreExtendedCopy;
  fleetIngressTitle: string;
  fleetIngressChoose: string;
  fleetIngressUnobserved: string;
  fleetIngressTunnel: string;
  fleetIngressEdge: string;
  fleetIngressTunnelBody: string;
  fleetIngressConnectors: string;
  fleetIngressConnectorsBody: string;
  fleetIngressEdgeBody: string;
  fleetIngressSuggestedBody: string;
  privateSharingTitle: string;
  privateSharingBody: string;
  privateSharingAdd: string;
  privateSharingRepository: string;
  privateSharingUnsupported: string;
  privateSharingMultipleMachines: string;
  privateSharingNetworkMissing: string;
  privateSharingService: string;
  privateSharingKey: string;
  privateSharingPort: string;
  privateSharingScheme: string;
  privateSharingNetwork: string;
  privateSharingAddress: string;
  privateSharingHostPort: string;
  privateSharingHostPortAutomatic: string;
  privateSharingJoinedPortReason: string;
  privateSharingReview: string;
  privateSharingNeeds: (params: { field: string }) => string;
  privateSharingReviewBody: string;
  privateSharingInvalid: string;
  privateSharingHappierNetwork: string;
  privateSharingHappierNetworkBody: string;
  privateSharingHappierNetworkPending: string;
  privateSharingStop: string;
  privateSharingStopConsequence: (params: Readonly<{ service: string }>) => string;
  privateSharingDetailTitle: (params: Readonly<{ service: string }>) => string;
  privateSharingDetailHappier: (params: Readonly<{ service: string }>) => string;
  privateSharingDetailNetwork: (params: Readonly<{ service: string; network: string }>) => string;
  privateSharingJoinedNetworkBody: string;
  privateSharingReviewBodyHappier: string;
  privateSharingWho: string;
  privateSharingOutcomeHappier: (params: Readonly<{ service: string }>) => string;
  privateSharingOutcomeNetwork: (params: Readonly<{ service: string; network: string }>) => string;
  privateSharingNeedsAdvanced: (params: Readonly<{ field: string }>) => string;
  privateSharingWhereToUse: string;
  privateSharingOpenVariables: (params: Readonly<{ environment: string }>) => string;
  referenceEnvironment: string;
  referenceNone: (params: Readonly<{ environment: string }>) => string;
  referenceNoneShare: string;
  destinationS3: (params: { region: string }) => string;
  destinationS3NoRegion: string;
  destinationTest: string;
  destinationReachable: string;
  destinationRepositoryMissing: string;
  destinationNativeFailed: string;
  destinationLocked: string;
  destinationPasswordIncorrect: string;
  destinationRetry: string;
  keepTitle: string;
  keepChange: string;
  keepDescription: string;
  keepLast: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  keepSave: string;
  keepCancel: string;
  keepInvalid: string;
  pruneTitle: string;
  pruneDescription: string;
  pruneAction: string;
  pruned: (params: { count: number }) => string;
  prunedNothing: string;
  rolloutRecreateShort: string;
  rolloutStartFirstShort: string;
  previewsTitle: string;
  previewsOn: string;
  previewsOff: string;
  previewsEnrollmentUnavailable: string;
  previewsRunsOn: string;
  previewsAddress: string;
  previewsData: string;
  previewsDataOwn: string;
  previewsDataBranch: string;
  previewsDataNone: string;
  previewsDataParent: string;
  previewsDataParentBody: string;
  previewsDataOwnUnavailable: string;
  previewsDataBranchUnavailable: string;
  previewsForks: string;
  previewsProductionTarget: string;
  previewsDataUnavailable: string;
  previewsSetUpOff: string;
  previewsNeedRepository: string;
  previewsNeedRepositoryBody: string;
  previewsNoRepository: string;
  backupNotSetUpTitle: string;
  backupNotSetUpBody: string;
  restoreOnFailOnBody: string;
  restoreOnFailOffBody: string;
  keptBody: string;
  setupTitle: string;
  setupDestination: string;
  setupSheetTitle: string;
  setupSheetLead: (params: { machine: string }) => string;
  setupSheetNext: string;
  setupInitializeAndSave: string;
  setupCreatingRepository: string;
  setupAnotherMachine: string;
  setupReceiverMachine: string;
  setupLocalWarning: string;
  setupLocalGrowth: string;
  keepEverythingNote: string;
  setupCapacityKnown: string;
  setupCapacityUnknown: string;
  setupCapacityAtBackupMachine: string;
  credentialSshPrivateKey: string;
  setupMoreOptions: string;
  setupNoDatabaseTitle: string;
  setupNoDatabaseBody: string;
  setupBody: string;
  setupStart: string;
  setupEndpoint: string;
  setupBucket: string;
  setupPrefix: string;
  setupRegion: string;
  setupService: string;
  setupSave: string;
  setupCancel: string;
  setupIncomplete: string;
  credentialAccessKeyId: string;
  credentialSecretAccessKey: string;
  credentialRepositoryPassword: string;
  credentialSessionToken: string;
  credentialMissing: string;
  credentialSet: string;
  credentialChoose: string;
  scheduleTitle: string;
  scheduleOff: string;
  scheduleOn: string;
  scheduleTurnOn: string;
  setupNoDestination: string;
  setupDestinationsUnavailable: string;
  setupOpenStore: string;
  setupRoleRequired: string;
  setupRoleOptional: string;
  setupNeedsSource: string;
  setupNeedsDestination: string;
  setupNeedsCredential: (params: { credential: string }) => string;
  addCheck: string;
  addCheckUnavailable: string;
}> & DeploymentOperationalTranslations;

export const deploymentSettingsTranslations = {
  en: {
    ...deploymentOperationalTranslations['en'],
    fleetIngressSuggestedBody: "Suggested from the Machines’ network information. Choose to save it; Domain setup will still check the route.",
    fleet: fleetCopy,
    databaseAccess: databaseAccessCopy,
    moveToRepository: moveToRepositoryCopy,
    previewEditor: previewEditorCopy,
    restoreExtended: restoreExtendedCopy,
    fleetIngressTitle: "Public route",
    fleetIngressChoose: "Choose a route",
    fleetIngressUnobserved: "No Domain zone or shared private network has been checked here. Choose a route; Domain setup will check it.",
    fleetIngressTunnel: "Cloudflare Tunnel",
    fleetIngressEdge: "Caddy edge",
    fleetIngressTunnelBody: "Connectors back each other up; they do not balance load. Without a private network, only host or connector loss is covered.",
    fleetIngressConnectors: "Connectors per Machine",
    fleetIngressConnectorsBody: "More connectors keep the address up if one stops; each uses a little memory on the Machine. Applies on the next deploy.",
    fleetIngressEdgeBody: "Balances traffic over a private network. The app is unreachable if the edge Machine stops.",
    privateSharingTitle: "Private sharing",
    privateSharingBody: "Share a service privately. Saved changes apply on the next deploy.",
    privateSharingAdd: "Share a service",
    privateSharingRepository: "This Environment runs its repository’s Compose file, so a service is shared from that file. Prepare with an agent opens a Session on the repository; tell it which service to share privately.",
    privateSharingUnsupported: "These exports need an agent to edit them without replacing existing access.",
    privateSharingMultipleMachines: "This editor can configure private sharing only for an Environment running on one Machine.",
    privateSharingNetworkMissing: "On the runtime Machine, open Network → Private networks, connect Tailscale, then join the same network as the other app.",
    privateSharingService: "Service",
    privateSharingKey: "Export name",
    privateSharingPort: "Container port",
    privateSharingScheme: "URL scheme",
    privateSharingNetwork: "Private network",
    privateSharingAddress: "Host address",
    privateSharingHostPort: "Published host port",
    privateSharingHostPortAutomatic: "Assigned when deployed",
    privateSharingJoinedPortReason: "A joined network needs a host port so Happier can open it in the Machine’s firewall before the service starts.",
    privateSharingReview: "Review sharing",
    privateSharingNeeds: ({ field }) => `Fill in “${field}” to review sharing.`,
    privateSharingReviewBody: "The next deployment binds this host address and port. Other apps can then use this private export.",
    privateSharingInvalid: "Check the service, export name, scheme and both ports.",
    privateSharingHappierNetwork: "Happier network",
    privateSharingHappierNetworkBody: "Your Machines reach it privately through Happier. No VPN needed.",
    privateSharingHappierNetworkPending: "Not available yet",
    privateSharingStop: "Stop sharing",
    privateSharingStopConsequence: ({ service }: Readonly<{ service: string }>) => `If you stop sharing, ${service} stops being shared at this environment’s next deploy, and anything that reaches it then loses the connection.`,
    privateSharingDetailTitle: ({ service }: Readonly<{ service: string }>) => `Sharing ${service}`,
    privateSharingDetailHappier: ({ service }: Readonly<{ service: string }>) => `Apps that can see this Environment reach ${service} privately through Happier. It stays off the internet.`,
    privateSharingDetailNetwork: ({ service, network }: Readonly<{ service: string; network: string }>) => `Apps on ${network} reach ${service} at its private address.`,
    privateSharingJoinedNetworkBody: "Apps on this network reach it at its private address.",
    privateSharingReviewBodyHappier: "The next deployment publishes this port on this Machine only. Your other Machines reach it through Happier.",
    privateSharingWho: "Who can use it",
    privateSharingOutcomeHappier: ({ service }: { service: string }) => `${service} stays off the internet. Apps that can see this Environment can connect to it privately from the next deploy.`,
    privateSharingOutcomeNetwork: ({ service, network }: { service: string; network: string }) => `Apps on ${network} can use ${service} at its private address from the next deploy.`,
    privateSharingNeedsAdvanced: ({ field }: { field: string }) => `Fill in “${field}” under Advanced to review sharing.`,
    privateSharingWhereToUse: "Another Environment in this Project connects to it from its Variables: Add › Point at another service.",
    privateSharingOpenVariables: ({ environment }: { environment: string }) => `Open ${environment}’s Variables`,
    referenceEnvironment: "Environment",
    referenceNone: ({ environment }: { environment: string }) => `${environment} shares no service yet.`,
    referenceNoneShare: "Share one in its Settings › Private sharing",
    destinationS3: ({ region }) => `S3 in ${region}`,
    destinationS3NoRegion: 'S3 storage',
    destinationTest: 'Test',
    destinationReachable: 'Reachable · tested just now',
    destinationRepositoryMissing:
      'No backup repository there yet · create one to start keeping backups',
    destinationNativeFailed:
      "The destination didn't answer · check its address",
    destinationLocked: 'Another backup is using it · Retry when it finishes',
    destinationPasswordIncorrect: "The repository password doesn't match",
    destinationRetry: "The test didn't finish · Retry",
    keepTitle: 'Keep',
    keepChange: 'Change',
    keepDescription:
      'After each backup, older ones past these counts are removed. Leave them all at 0 to keep every backup.',
    keepLast: 'Most recent',
    keepDaily: 'Daily',
    keepWeekly: 'Weekly',
    keepMonthly: 'Monthly',
    keepSave: 'Save',
    keepCancel: 'Cancel',
    keepInvalid: 'Use whole numbers',
    pruneTitle: 'Remove old backups now',
    pruneDescription:
      'Removes the backups past what you keep, without waiting for the next backup.',
    pruneAction: 'Remove',
    pruned: ({ count }) =>
      count === 1 ? 'Removed 1 old backup' : `Removed ${count} old backups`,
    prunedNothing: 'Nothing past what you keep',
    rolloutRecreateShort: 'Restart in place',
    rolloutStartFirstShort: 'Start new first',
    previewsTitle: 'Previews',
    previewsOn: 'On for new pull requests. Turning this on skips pull requests that are already open.',
    previewsOff: 'Off',
    previewsEnrollmentUnavailable: "Saved, but new pull requests won't get previews yet",
    previewsRunsOn: 'Runs on',
    previewsAddress: 'Address',
    previewsData: 'Data',
    previewsDataOwn: 'Its own database',
    previewsDataBranch: 'A branch of the database',
    previewsDataNone: 'None',
    previewsDataParent: "Branched from",
    previewsDataParentBody: "Each pull request gets a branch with no data copied, deleted when the pull request closes",
    previewsDataOwnUnavailable: "Its own database is set up by an agent",
    previewsDataBranchUnavailable: "Branching needs a linked database that supports it",
    previewsForks: "Pull requests from forks don't get previews",
    previewsProductionTarget: 'Previews share the production target',
    previewsDataUnavailable: 'Not set up for this environment · ask an agent to set it up',
    previewsSetUpOff: 'Off · turn on to give each pull request its own copy of this environment',
    previewsNeedRepository: 'Previews need a repository',
    previewsNeedRepositoryBody: "This environment's definition is stored in Happier. Previews build each pull request from a repository.",
    previewsNoRepository: "Previews need the Project's repository",
    backupNotSetUpTitle: 'Not backed up',
    backupNotSetUpBody: "No backup is set up, so this environment's data isn't copied anywhere.",
    restoreOnFailOnBody: 'A deploy that fails its health checks goes back to the last good release',
    restoreOnFailOffBody: 'A failed deploy stays as it is until you roll back',
    keptBody: 'Releases kept on the server so you can roll back without rebuilding',
    setupTitle: 'Set up backups',
    setupDestination: 'Destination',
    setupSheetTitle: "Where should backups go?",
    setupSheetLead: ({ machine }: { machine: string }) => `Each backup is encrypted on ${machine} before it leaves.`,
    setupSheetNext: "Test the storage, then save. Initialize only a new repository.",
    setupMoreOptions: "More options",
    setupNoDatabaseTitle: "Add a database first",
    setupNoDatabaseBody: "Backups copy a database this Environment runs.",
    setupBody: "Choose storage for encrypted backup copies.",
    setupStart: 'Set up',
    setupEndpoint: 'Endpoint',
    setupBucket: 'Bucket',
    setupPrefix: 'Folder in the bucket',
    setupRegion: 'Region',
    setupService: 'Database service',
    setupSave: 'Save',
    setupCancel: 'Cancel',
    setupIncomplete: "Complete the storage, source and required Saved Secrets to continue.",
    credentialAccessKeyId: 'Access key ID',
    credentialSecretAccessKey: 'Secret access key',
    credentialRepositoryPassword: 'Repository password',
    credentialSessionToken: 'Session token',
    credentialMissing: 'Needs a Saved Secret',
    credentialSet: 'Saved Secret chosen',
    credentialChoose: 'Choose…',
    scheduleTitle: 'Nightly backups',
    scheduleOff: 'Off · backs up every night at 02:00, checks each copy and keeps your counts',
    scheduleOn: 'On · every night at 02:00',
    scheduleTurnOn: 'Turn on',
    setupNoDestination: 'Backups need somewhere to keep the copies. Add backup storage from the Store first.',
    setupDestinationsUnavailable: 'Backup storage options couldn’t be read right now. Try again in a moment.',
    setupOpenStore: 'Open Store',
    setupRoleRequired: "Required Saved Secret",
    setupRoleOptional: 'Optional · only if your storage uses it',
    setupNeedsSource: "Choose what to back up first.",
    setupNeedsDestination: "Fill in where backups go first.",
    setupNeedsCredential: ({ credential }: { credential: string }) => `${credential}: choose a saved secret first.`,
    setupInitializeAndSave: "Create repository and save",
    setupCreatingRepository: "Creating the repository…",
    setupAnotherMachine: "Another Machine",
    setupReceiverMachine: "Destination Machine",
    setupLocalWarning: "On this Machine · not an off-site copy",
    setupLocalGrowth: "This disk can fill up.",
    keepEverythingNote: "With every count at 0, all backups are kept.",
    setupCapacityKnown: "Free space",
    setupCapacityUnknown: "Free space unavailable",
    setupCapacityAtBackupMachine: "Review free space on the Machine that owns this backup path.",
    credentialSshPrivateKey: "SSH private key",
    addCheck: 'Add check',
    addCheckUnavailable:
      "Checks can't be set up from here · open the Machine's Services page",
  },
} satisfies Pick<Record<SupportedLanguage, DeploymentSettingsTranslations>, 'en'>;
