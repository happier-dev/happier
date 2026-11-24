/**
 * Copy of an Environment's Telemetry tab and its one setup sheet (P7 J1, lab `p7Setup`). Wired as the
 * `deploymentTelemetry` namespace by every locale.
 */
type Name = Readonly<{ name: string }>;
type MachineName = Readonly<{ machine: string }>;

export type Copy = Readonly<{
  tab: string;
  empty: Readonly<{
    title: (p: Name) => string;
    body: string;
    action: string;
    note: string;
  }>;
  recording: Readonly<{
    title: string;
    keptOn: (p: MachineName) => string;
    appCollector: (p: Name) => string;
    nextDeploy: string;
    waiting: string;
    storageFull: string;
    receiving: (p: Readonly<{ time: string }>) => string;
  }>;
  state: Readonly<{ on: string; off: string }>;
  tabs: Readonly<{
    label: string;
    endpoints: string;
    traces: string;
    logs: string;
    queries: string;
    llmCalls: string;
    metrics: string;
  }>;
  /** While a recorded choice has kept nothing yet (lab p7Setup-waiting): each choice's own delivery. */
  readiness: Readonly<{ title: string; description: string }>;
  /** Telemetry → LLM calls (J4): typed totals and coverage, then each retained call. */
  llm: Readonly<{
    calls: string;
    tokens: (p: Readonly<{ count: string }>) => string;
    reported: string;
    reportedFor: (p: Readonly<{ reported: string; calls: string }>) => string;
    reportedNone: string;
    note: string;
    openUsage: string;
    reading: string;
    unavailable: string;
  }>;
  /** Telemetry → Metrics (J5): one service's request time, traffic, errors and heap over the window. */
  metrics: Readonly<{
    service: string;
    duration: string;
    durationDetail: (p: Readonly<{ p50: string }>) => string;
    requests: string;
    requestsDetail: string;
    errorRate: string;
    heap: string;
    heapNotReported: string;
    noService: string;
    reading: string;
    unavailable: string;
  }>;
  window: Readonly<{ label: string; hour: string; day: string; week: string }>;
  menu: Readonly<{ settings: string; addTelemetry: string; clear: string; clearFailed: string }>;
  offline: Readonly<{
    title: (p: MachineName) => string;
    reason: string;
    body: string;
  }>;
  unavailable: Readonly<{ title: string; reason: string }>;
  request: Readonly<{
    back: string;
    backToCalls: string;
    waterfall: string;
    reading: string;
    unavailable: string;
    investigate: string;
    investigateFailed: string;
    queries: (p: Readonly<{ count: number }>) => string;
  }>;
  addCheck: string;
  /** A worktree's own capture on its Dev servers page (P5 F7, lab dbCapture). */
  local: Readonly<{
    views: string;
    servers: string;
    on: string;
    off: string;
    offTitle: string;
    offBody: string;
    turnOn: string;
    turnOnFailed: string;
    turnOff: string;
    turnOffFailed: string;
    retry: string;
    preparing: string;
    missed: (p: Readonly<{ count: string }>) => string;
    gaps: string;
    unavailableTitle: string;
    unavailableBody: string;
    stale: string;
    restart: string;
    restartReason: string;
    waitingTitle: string;
    waitingBody: string;
    window: Readonly<{ quarter: string; hour: string; day: string }>;
  }>;
  measurement: Readonly<{ sampled: string; partial: string; unknown: string }>;
  sheet: Readonly<{
    title: (p: Name) => string;
    purpose: string;
    collector: string;
    collectorDescription: string;
    collectorPublicDomain: string;
    collectorPublicDomainEmpty: string;
    wranglerTitle: string;
    wranglerBody: string;
    machine: string;
    rotate: string;
    rotateDescription: string;
    noCollector: string;
    team: string;
    deployCollector: string;
    enableRole: string;
    askRoleOwner: string;
    record: string;
    requests: string;
    requestsDescription: string;
    notReceiving: string;
    lastSample: (p: Readonly<{ time: string }>) => string;
    afterDeploy: string;
    regression: string;
    regressionDescription: string;
    regressionAction: string;
    regressionFailed: string;
    exceptions: string;
    exceptionsDescription: string;
    llm: string;
    llmDescription: string;
    metrics: string;
    metricsDescription: string;
    sampling: string;
    samplingUnset: string;
    samplingAuthored: string;
    samplingSet: (p: Readonly<{ percent: string }>) => string;
    samplingVariables: string;
    samplingLower: string;
    samplingPrompt: string;
    keptEncrypted: (p: MachineName) => string;
    keptPlain: (p: MachineName) => string;
    save: string;
    confirmDeleteTitle: string;
    confirmDelete: (p: MachineName) => string;
    deleteAndSave: string;
    noAccess: string;
    refused: Readonly<{
      collector_required: string;
      telemetry_role_inactive: string;
      machine_unavailable: string;
      other: string;
    }>;
  }>;
}>;

const en: Copy = {
  tab: 'Telemetry',
  empty: {
    title: ({ name }) => `See what ${name} does`,
    body: 'Slow endpoints, the queries each request runs, errors and model calls, kept on a Machine you choose. Agents can read them to fix what they find.',
    action: 'Set up telemetry…',
    note: 'Your app sends OpenTelemetry; Happier sets the variables at the next deploy.',
  },
  recording: {
    title: 'Recording',
    keptOn: ({ machine }) => `Kept on ${machine}.`,
    appCollector: ({ name }) => `Uses your own collector · ${name}`,
    nextDeploy: 'Changes apply at the next deploy.',
    waiting: 'Waiting for first data',
    storageFull: 'Collector storage full',
    receiving: ({ time }) => `Receiving · ${time}`,
  },
  state: { on: 'On', off: 'Off' },
  tabs: {
    label: 'What the collector kept',
    endpoints: 'Endpoints',
    traces: 'Traces',
    logs: 'Logs',
    queries: 'Queries',
    llmCalls: 'LLM calls',
    metrics: 'Metrics',
  },
  readiness: {
    title: 'Getting ready',
    description: 'Each choice starts as soon as its data arrives.',
  },
  llm: {
    calls: 'Model calls',
    tokens: ({ count }) => `${count} tokens`,
    reported: 'Reported by the provider',
    reportedFor: ({ reported, calls }) => `for ${reported} of ${calls} calls`,
    reportedNone: 'Your SDK doesn’t report cost',
    note: 'Your app’s own model calls. Usage prices them with your prices; what your agents use is never added to them.',
    openUsage: 'Open Usage',
    reading: 'Reading model calls',
    unavailable: 'Model calls aren’t available right now',
  },
  metrics: {
    service: 'Service',
    duration: 'Request duration',
    durationDetail: ({ p50 }) => `p95 · p50 ${p50}`,
    requests: 'Requests',
    requestsDetail: 'per second',
    errorRate: 'Error rate',
    heap: 'Heap used',
    heapNotReported: 'This runtime doesn’t report heap use.',
    noService: 'No requests in this window yet',
    reading: 'Reading metrics',
    unavailable: 'Metrics aren’t available right now',
  },
  window: { label: 'Time window', hour: '1 h', day: '24 h', week: '7 d' },
  menu: { settings: 'Telemetry settings…', addTelemetry: 'Add telemetry to this app', clear: 'Clear capture…', clearFailed: 'Capture could not be cleared.' },
  offline: {
    title: ({ machine }) => `${machine} isn’t answering`,
    reason: 'your app keeps running; this is what Happier last read',
    body: 'Your app keeps running. Its telemetry shows here once the collector is back.',
  },
  unavailable: {
    title: 'Telemetry isn’t available right now',
    reason: 'the collector didn’t answer this read',
  },
  request: {
    investigate: 'Send to agent',
    investigateFailed: 'Could not open the finding brief',
    back: 'All traces',
    backToCalls: 'All LLM calls',
    waterfall: 'Waterfall',
    reading: 'Reading the request',
    unavailable: 'This request isn’t available',
    queries: ({ count }) => (count === 1 ? '1 query' : `${count} queries`),
  },
  addCheck: 'Add a check…',
  local: {
    views: 'What this checkout ran',
    servers: 'Servers',
    on: 'Capture on',
    off: 'Request capture is off',
    offTitle: 'See what your dev servers do',
    offBody: 'Each request’s route, time, database queries and logs, kept on this Machine. Turning capture on restarts the dev servers once.',
    turnOn: 'Turn on capture',
    turnOnFailed: 'Capture could not be turned on.',
    turnOff: 'Turn off capture',
    turnOffFailed: 'Capture could not be turned off.',
    retry: 'Retry capture',
    preparing: 'Preparing capture…',
    missed: ({ count }) => `${count} events weren’t kept`,
    gaps: 'Capture on with gaps',
    unavailableTitle: 'Capture isn’t answering right now',
    unavailableBody: 'Capture keeps each request’s route, time, database queries and logs on this Machine. Try again in a moment.',
    stale: 'Capture isn’t answering · showing what it last read',
    restart: 'Restart the dev servers to capture their requests.',
    restartReason: 'Capture changed while they were running.',
    waitingTitle: 'Waiting for the first request',
    waitingBody: 'Open the app and its requests appear here as they happen.',
    window: { quarter: '15 min', hour: '1 h', day: '24 h' },
  },
  measurement: {
    sampled: 'Includes sampled requests',
    partial: 'Some observations are missing',
    unknown: 'No collector data for this window',
  },
  sheet: {
    title: ({ name }) => `Telemetry for ${name}`,
    purpose: 'What Happier records from this app, and where it keeps it.',
    collector: 'Collector',
    collectorDescription:
      'The Machine that receives and keeps what this Environment records.',
    collectorPublicDomain: 'Choose a public HTTPS Domain for the collector',
    collectorPublicDomainEmpty: 'There is no public HTTPS Domain for this collector.',
    wranglerTitle: 'Add to your Wrangler config',
    wranglerBody: 'Add these destination names to your Worker’s observability configuration, then deploy again.',
    machine: 'Machine',
    rotate: 'Rotate collector credential',
    rotateDescription: 'Replaces the current credential. Deploy again to send telemetry with the new credential.',
    noCollector:
      'No Machine has its Telemetry role on yet. Turn it on for a Machine that stays on, in that Machine’s Roles.',
    team: 'Your teammates read telemetry from the same Machine, as this Environment’s permissions allow. Personal computers sleep, so choose one that stays on.',
    deployCollector: 'Deploy a collector next to your relay',
    enableRole: 'Turn on Telemetry',
    askRoleOwner: 'Ask the Machine’s owner to turn on Telemetry.',
    record: 'Record',
    requests: 'Requests and queries',
    requestsDescription:
      'Endpoints, traces, logs and the queries each request runs.',
    notReceiving: 'Not receiving yet',
    lastSample: ({ time }) => `Receiving · last sample ${time}`,
    afterDeploy: 'After each deploy',
    regression: 'Compare each deploy with the one before',
    regressionDescription:
      'Sets up a workflow you can read and change: what to compare, for how long, and what counts as slower.',
    regressionAction: 'Set up…',
    regressionFailed: 'The workflow couldn’t be opened.',
    exceptions: 'Exceptions',
    exceptionsDescription:
      'Server errors become issues in PRs & Issues. Browser errors need a small addition to your app.',
    llm: 'App LLM calls',
    llmDescription:
      'Model, tokens and time for each call your app makes. Prompts and replies are never kept.',
    metrics: 'Runtime metrics',
    metricsDescription:
      'Heap, garbage collection, request duration and requests in flight.',
    sampling: 'Trace sampling',
    samplingUnset: 'Sampler variable not set (SDK default 100%).',
    samplingAuthored: 'Set by your app for services with their own sampler.',
    samplingSet: ({ percent }) => `Environment sampler: ${percent} (applies on deploy).`,
    samplingVariables: 'Set in this Environment’s Variables.',
    samplingLower: 'Lower…',
    samplingPrompt: 'Enter the percentage of traces to keep (0 to 100). This applies at the next deploy.',
    keptEncrypted: ({ machine }) =>
      `Requests, stacks and logs stay on ${machine}. Issue titles and counts are saved to your account, encrypted.`,
    keptPlain: ({ machine }) =>
      `Requests, stacks and logs stay on ${machine}. Issue titles and counts are saved to your account.`,
    save: 'Save',
    confirmDeleteTitle: 'This deletes the telemetry kept so far',
    confirmDelete: ({ machine }) =>
      `${machine} deletes what it kept for this Environment. Save again to go ahead.`,
    deleteAndSave: 'Delete and save',
    noAccess:
      'Only people who can change this Environment’s variables can change its telemetry.',
    refused: {
      collector_required:
        'Choose a Machine to keep this Environment’s telemetry.',
      telemetry_role_inactive:
        'That Machine’s Telemetry role is off. Turn it on, or choose another Machine.',
      machine_unavailable:
        'That Machine isn’t in this Home anymore. Choose another one.',
      other: 'Telemetry couldn’t be saved. Your choices are kept here.',
    },
  },
};

export const deploymentTelemetryTranslations = {
  en,
} as const;
