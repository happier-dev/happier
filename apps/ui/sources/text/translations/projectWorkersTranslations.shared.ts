/**
 * Copy for where Project work runs (plans 30–32): the Run on picker, a checkout's worker
 * preferences, a Machine's "Work from your projects" settings and a service's Runs on / Move.
 * English is the shape every locale block (`features/projectWorkers.<locale>.ts`) must match.
 */
export const projectWorkersEn = {
  projectWorkers: {
    draftKept: 'Your change isn’t saved yet.',
    draftRetry: 'Try saving again',
    draftDiscard: 'Discard change',
    queuedOn: ({ machine }: { machine: string }) => `Queued on ${machine}`,
    ahead: ({ count }: { count: number }) => `${count} ahead`,
    copying: ({ machine }: { machine: string }) => `Copying current files to ${machine}…`,
    preparing: ({ machine }: { machine: string }) => `Preparing the project on ${machine}…`,
    freshCopySynced: ({ time }: { time: string }) => `fresh copy synced ${time}`,
    guideTitle: 'What agents are told',
    guideDetail: 'Generated from the project file and your preferences. Updated when either changes.',
    guideHeader: ({ project }: { project: string }) => `Project scripts for ${project} (from .happier/project.json)`,
    guideWorker: 'may run on a worker',
    guidePrimary: 'this checkout only',
    guideNoScripts: 'No scripts in the project file yet.',
    guideRunOne: 'Run one:',
    guideOutput: 'Output streams back. Files the script writes stay where it ran.',
    guideQueue: 'A busy worker queues the run there. Wait for it; don’t start it again.',
    guideExit: 'A non-zero exit is the result. Read the output before rerunning.',
    guideOther: 'Other commands on a worker:',
    guideAdHocOff: 'Off for this workspace. When on, every command follows your approval settings.',
    guideAdHocOn: 'On for this workspace. Every command follows your approval settings.',
    guideUnavailable: 'Couldn’t read what agents are told.',
    title: 'Workers',
    description:
      'Where scripts marked “Any worker” run from this checkout. Saved for you; teammates choose their own.',
    backToScripts: 'Back to Scripts',
    primary: 'This machine',
    defaultSection: 'Default for this checkout',
    enabled: 'Run portable scripts on workers',
    enabledDetail: 'Off keeps every script on this machine.',
    destination: 'Run on',
    destinationDetail: 'A pool or one machine you may run project work on',
    pickWorker: 'Pick the worker',
    automatic: 'Choose automatically',
    ask: 'Ask each time',
    whenUnavailable: 'If no worker can accept',
    whenUnavailableDetail:
      'Only when no worker accepts at all. A busy one queues the run instead.',
    fallbackAsk: 'Ask me',
    fallbackPrimary: 'Run here instead',
    fallbackFail: 'Don’t run',
    perScript: 'Per script',
    perScriptDetail:
      'The project file decides which scripts may leave this checkout; here you choose where yours go.',
    overrideDefault: 'Default',
    overrideWorkers: 'Workers',
    defaultSummary: ({ destination }: { destination: string }) =>
      `Default: ${destination}`,
    alwaysWorker: 'Always on a worker',
    alwaysPrimary: 'Always on this machine',
    primaryOnly: 'This script runs on the primary checkout.',
    poolAutomatic: ({ pool }: { pool: string }) => `${pool}, automatically`,
    poolAsk: ({ pool }: { pool: string }) => `${pool}, ask each time`,
    agents: 'Agents',
    adHoc: 'Allow explicit ad-hoc commands',
    adHocDetail: 'Commands follow your Action approval settings.',
    reset: 'Reset worker preferences…',
    resetDetail: 'Asks first. Running work isn’t moved or stopped.',
    resetConfirm: 'Reset worker preferences for this checkout?',
    empty: 'No eligible workers',
    emptyDetail: 'Connect a machine or choose a different pool.',
    loading: 'Checking workers…',
    unsupported: 'Project work is unavailable on this machine.',
    accessRefused: 'You don’t have access to run work here.',
    policyUnavailable: 'Worker settings are unavailable.',
    workspaceUnavailable: 'The worker checkout is unavailable.',
    statusUnavailable: 'Worker status is unavailable.',
    free: 'Free',
    runningCount: ({ count }: { count: number }) => `${count} running`,
    queuedCount: ({ count }: { count: number }) => `${count} queued`,
    waitsThere: 'it’ll wait there',
    loadUnknown: 'Load unavailable',
    tooSmall: ({ script, need, available }: { script: string; need: string; available?: string }) =>
      `Too small: ${script} needs about ${need}${available ? `, it has ${available}` : ''}`,
    memoryUnavailable: 'Memory unavailable',
    tooSmallGeneric: 'Not enough memory for this work',
    notAccepting: 'Not accepting new work',
    notAcceptingDetail: 'Already accepted work can finish.',
    draining: 'Finishing accepted work before stopping.',
    noCopyNeeded: 'no copy needed',
    runOn: ({ name }: { name: string }) => `Run ${name} on`,
    workersSection: 'Workers',
    poolsSection: 'Pools',
    workerSettings: 'Worker settings…',
    workerSettingsDetail: 'Your defaults for this checkout',
    oneWayCopy:
      'Workers run from a fresh one-way copy of this checkout. Nothing copies back.',
    scriptsRow: 'Workers',
    scriptsRowOff: 'Every script runs on this machine',
    scriptsRowOn: ({ destination }: { destination: string }) =>
      `Any-worker scripts: ${destination}`,
    scriptsRowAutomatic: ({ pool }: { pool: string }) =>
      `choose automatically from ${pool}`,
    scriptsRowAsk: ({ pool }: { pool: string }) => `ask each time from ${pool}`,
    // Machine › Work from your projects
    workSection: 'Work from your projects',
    workSectionDetail:
      'Scripts marked “Any worker” can run here from a fresh copy of their checkout. Each run gets its own terminal.',
    accepting: 'Accept new work',
    acceptingNow: 'Accepting',
    capacity: 'Run at most',
    capacityDetail: 'Extra runs wait here in order.',
    noLimit: 'No limit',
    capacityInvalid: 'Enter a positive whole number.',
    runningHere: 'Running here',
    nothingRunning: 'Nothing from your projects is running here.',
    yours: ({ machine }: { machine: string }) => `Yours, from ${machine}`,
    open: 'Open',
    freshCopies: 'Fresh copies',
    freshCopiesDetail:
      'One folder per checkout, kept between runs so caches stay warm. .git, secrets and Happier state are never copied.',
    freshCopiesEmpty: 'No fresh copies on this machine yet.',
    manageInSync: 'Manage links in Sync',
    copyFrom: ({ machine }: { machine: string }) => `From ${machine}`,
    remove: 'Remove…',
    removeDetail:
      'Work that depends on this copy is checked first. Its files stay on the machine.',
    removeInUse: 'This copy is in use. Finish or cancel its work first.',
    removeUnknown: 'The result is unknown. Check the copy before trying again.',
    removeFailed: 'Couldn’t remove this copy.',
    copyLastSynced: ({ time }: { time: string }) => `last synced ${time}`,
    copySynced: ({ time }: { time: string }) => `Synced ${time}`,
    freshCopiesUnavailable: 'Fresh copies can’t be shown right now.',
    removeKeepFiles: 'Stop keeping this copy',
    removeWithFiles: 'Also remove its files',
    removeWithFilesDetail: ({ machine }: { machine: string }) => `Deletes the folder on ${machine}.`,
    copyMissing: ({ machine }: { machine: string }) => `${machine} has no copy of this project yet.`,
    copyMissingFact: 'Needs a copy first',
    setUpCopy: ({ machine }: { machine: string }) => `Set up a copy on ${machine}`,
    removeFilesUnknown: 'This copy may already be gone, but whether its files were removed is unknown. Check the folder before trying again.',
    checkAgain: 'Check again',
    openWork: 'Open',
    dependencyOther: 'Other work',
    dependencyQueued: 'Queued',
    dependencyReserved: 'Starting',
    dependencyCopying: 'Copying files',
    dependencySetup: 'Preparing',
    dependencyRunning: 'Running',
    wakeForRun: 'starts for this run, then the run begins',
    runAfterWake: 'the run begins when it’s ready',
    runWaitsForMachine: ({ script, machine }: { script: string; machine: string }) => `${script} starts on ${machine} as soon as it joins.`,
    creationStopped: ({ machine }: { machine: string }) => `Stopped waiting for ${machine}. It may still be created and billed.`,
    continueWithMachine: ({ machine }: { machine: string }) => `Continue with ${machine}`,
    scriptStartsWhenReady: ({ script }: { script: string }) => `${script} starts when it’s ready`,
    // Writes
    saving: 'Saving…',
    approvalPending: 'Waiting for your approval…',
    writeUnknown:
      'The save result is unknown. Check the current settings before trying again.',
    changed: 'These settings changed. Review the current value.',
    saveFailed: 'Couldn’t save worker settings.',
    destinationMissing: 'The saved destination is unavailable.',
    settingsLocked:
      'Worker settings are locked. Unlock your account to change them.',
  },
  projectServices: {
    actualAmbiguous: 'Running in more than one place',
    actualAmbiguousDetail: 'Choose where it runs once only one instance is running.',
    actualUnavailable: 'Where it runs right now can’t be checked.',
    primaryOnly: 'This service runs on the primary checkout.',
    willStartOn: ({ name }: { name: string }) => `Next start on ${name}`,
    moving: ({ service, to }: { service: string; to: string }) => `Moving ${service} to ${to}…`,
    cancelPending: 'Cancelling move…',
    inspect: 'Inspect',
    moveFailedStopped: 'The service stopped, but couldn’t start on the new machine.',
    moveCancelledStopped: 'Move cancelled. The service is stopped.',
    otherMachine: 'Another machine',
    runsOn: 'Runs on',
    anyWorker: 'Any worker',
    anyWorkerDetail: ({ pool }: { pool: string }) =>
      `${pool} picks when it starts`,
    thisMachine: ({ name }: { name: string }) => `This machine · ${name}`,
    runsHere: 'Runs next to this checkout.',
    runsOnWorker: ({ name }: { name: string }) =>
      `Starts on ${name} from a fresh copy of this checkout.`,
    whenUnavailable: 'If it can’t run there',
    fallbackPrimary: 'Run here instead',
    fallbackFail: 'Don’t start',
    destinationMissing: 'The saved destination is unavailable.',
    settingsUnavailable: 'Service placement settings are unavailable.',
    saveFailed: 'Couldn’t save service placement.',
    changed: 'Placement changed. Review the current value.',
    saving: 'Saving…',
    saveUnknown: 'The save result is unknown. Check the current placement.',
    move: 'Move service',
    moveConfirm: ({
      service,
      from,
      to,
    }: {
      service: string;
      from: string;
      to: string;
    }) => `Move ${service} from ${from} to ${to}?`,
    moveDetail:
      'Stop the current service, copy current files, then start on the selected machine. If starting fails, the service stays stopped. Sharing may need to be set up again.',
    moveUnavailable:
      'Moving a running service isn’t available yet. Nothing was changed.',
    moveRefused: 'This service can’t be moved right now. Nothing was changed.',
    moveUnknown:
      'The move result is unknown. Check the service before trying again.',
  },
};

type TranslationShape<T> = T extends (...args: infer Args) => infer Return
  ? (...args: Args) => Return
  : T extends string
    ? string
    : { readonly [K in keyof T]: TranslationShape<T[K]> };

export type ProjectWorkersTranslations = TranslationShape<
  typeof projectWorkersEn
>;
