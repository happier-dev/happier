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
    nextDeploy: string;
  }>;
  state: Readonly<{ on: string; off: string }>;
  tabs: Readonly<{
    label: string;
    endpoints: string;
    traces: string;
    logs: string;
    queries: string;
  }>;
  window: Readonly<{ label: string; hour: string; day: string; week: string }>;
  menu: Readonly<{ settings: string; clear: string }>;
  clear: Readonly<{
    title: (p: Name) => string;
    body: (p: MachineName) => string;
    confirm: string;
    failed: string;
  }>;
  offline: Readonly<{
    title: (p: MachineName) => string;
    reason: string;
    body: string;
  }>;
  unavailable: Readonly<{ title: string; reason: string }>;
  request: Readonly<{
    back: string;
    waterfall: string;
    reading: string;
    unavailable: string;
    queries: (p: Readonly<{ count: number }>) => string;
  }>;
  addCheck: string;
  measurement: Readonly<{ sampled: string; partial: string; unknown: string }>;
  sheet: Readonly<{
    title: (p: Name) => string;
    purpose: string;
    collector: string;
    collectorDescription: string;
    machine: string;
    noCollector: string;
    team: string;
    record: string;
    requests: string;
    requestsDescription: string;
    exceptions: string;
    exceptionsDescription: string;
    llm: string;
    llmDescription: string;
    metrics: string;
    metricsDescription: string;
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
    nextDeploy: 'Changes apply at the next deploy.',
  },
  state: { on: 'On', off: 'Off' },
  tabs: {
    label: 'What the collector kept',
    endpoints: 'Endpoints',
    traces: 'Traces',
    logs: 'Logs',
    queries: 'Queries',
  },
  window: { label: 'Time window', hour: '1 h', day: '24 h', week: '7 d' },
  menu: { settings: 'Telemetry settings…', clear: 'Clear telemetry…' },
  clear: {
    title: ({ name }) => `Clear telemetry for ${name}?`,
    body: ({ machine }) =>
      `${machine} deletes the requests, logs and queries it kept for this Environment. New data keeps arriving.`,
    confirm: 'Clear',
    failed: 'Telemetry couldn’t be cleared. Try again.',
  },
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
    back: 'All traces',
    waterfall: 'Waterfall',
    reading: 'Reading the request',
    unavailable: 'This request isn’t available',
    queries: ({ count }) => (count === 1 ? '1 query' : `${count} queries`),
  },
  addCheck: 'Add a check…',
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
    machine: 'Machine',
    noCollector:
      'No Machine has its Telemetry role on yet. Turn it on for a Machine that stays on, in that Machine’s Roles.',
    team: 'Your teammates read telemetry from the same Machine, as this Environment’s permissions allow. Personal computers sleep, so choose one that stays on.',
    record: 'Record',
    requests: 'Requests and queries',
    requestsDescription:
      'Endpoints, traces, logs and the queries each request runs.',
    exceptions: 'Exceptions',
    exceptionsDescription:
      'Server errors become issues in PRs & Issues. Browser errors need a small addition to your app.',
    llm: 'App LLM calls',
    llmDescription:
      'Model, tokens and time for each call your app makes. Prompts and replies are never kept.',
    metrics: 'Runtime metrics',
    metricsDescription:
      'Heap, garbage collection, request duration and requests in flight.',
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
