// MCP servers homepage copy (P7 U7.11, lab hm-A and mp-E): the reach map, its legend, the present line,
// the first visit, the brand-new and empty states. Mounted under `capabilities.mcpHome`.

type Count = Readonly<{ count: number }>;

export type McpHomeTranslation = Readonly<{
  purpose: string;
  loadFailed: string;
  firstHeadline: string;
  firstPurpose: string;
  firstDismiss: string;
  groupAccount: string;
  groupMachine: string;
  newAccountBody: string;
  newMachineBody: string;
  factAs: (params: Readonly<{ identity: string }>) => string;
  factSignedIn: string;
  factKey: string;
  present: (
    params: Readonly<{ servers: number; tools: number; tokens: string }>,
  ) => string;
  presentNoTools: (params: Count) => string;
  presentNone: string;
  needYou: (params: Count) => string;
  needsTitle: string;
  needsAccount: string;
  needsAccountTools: (params: Count) => string;
  needsKey: string;
  needsKeyNamed: (params: Readonly<{ names: string }>) => string;
  previewSignedInAs: (params: Readonly<{ identity: string }>) => string;
  previewSignedIn: string;
  previewKey: string;
  previewMachine: string;
  previewOff: string;
  previewExpired: string;
  previewSignIn: string;
  previewNeedsKey: string;
  newTitle: string;
  newBody: string;
  browse: string;
  paste: string;
  shelfTitle: string;
  shelfFrom: (params: Readonly<{ source: string }>) => string;
  shelfAdd: string;
  foundTitle: string;
  foundBody: string;
  foundLine: (params: Readonly<{ count: number; machine: string }>) => string;
  foundLineMachines: (
    params: Readonly<{ count: number; machines: number }>,
  ) => string;
  foundLineBody: string;
  review: string;
  mapLabel: (params: Count) => string;
  more: (params: Count) => string;
}>;

export const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

const en: McpHomeTranslation = {
  loadFailed: 'Couldn’t load your servers',
  purpose:
    'Tools your agents can call: your issue tracker, a browser, a database. Sign in once and every machine can use them.',
  firstHeadline: 'Your servers now follow you',
  firstPurpose:
    'They kept working where they were. Now a server that needs a sign-in works too: sign in once, from any device, and every machine can use it.',
  firstDismiss: 'Got it',
  groupAccount: 'Signed in once, on every machine',
  groupMachine: 'Runs on your machines',
  newAccountBody:
    'Linear, Sentry or Notion: sign in from any device, even your phone.',
  newMachineBody:
    'A browser or a database: Happier starts it on the machine your session runs on.',
  factAs: ({ identity }) => `as ${identity}`,
  factSignedIn: 'Signed in',
  factKey: 'API key · saved secret',
  present: ({ servers, tools, tokens }) =>
    `${servers} ${plural(servers, 'server gives', 'servers give')} your agents ${tools} ${plural(tools, 'tool', 'tools')}, about ${tokens} tokens of context.`,
  presentNoTools: ({ count }) =>
    `${count} ${plural(count, 'server is', 'servers are')} on for your agents.`,
  presentNone: 'No server is on yet.',
  needYou: ({ count }) => ` ${count} ${plural(count, 'needs', 'need')} you.`,
  needsTitle: 'Needs you',
  needsAccount: 'Fix it once, from any device, and every machine can use it',
  needsAccountTools: ({ count }) =>
    `Fix it once, from any device, and every machine gets its ${count} ${plural(count, 'tool', 'tools')} back`,
  needsKey: 'Add the key once as a saved secret, and every machine can use it',
  needsKeyNamed: ({ names }) => `Add ${names} once as a saved secret, and every machine can use it`,
  previewSignedInAs: ({ identity }) =>
    `Signed in as ${identity}, for every machine`,
  previewSignedIn: 'Signed in once, for every machine',
  previewKey: 'Its key is a saved secret, used on every machine',
  previewMachine: 'Starts on the machine your session runs on',
  previewOff: 'Off: no agent gets it',
  previewExpired:
    'Its sign-in ran out. Reconnect once and every machine has it back.',
  previewSignIn: 'Sign in once, from any device, and every machine can use it.',
  previewNeedsKey:
    'It needs a key. Add it once, as a saved secret, and every machine can start it.',
  newTitle: 'Give your agents more tools',
  newBody:
    'An MCP server gives your agents tools: your issue tracker, a browser, a database. Add one here, sign in once, and it works on every machine.',
  browse: 'Browse servers',
  paste: 'Paste a config',
  shelfTitle: 'Suggested servers',
  shelfFrom: ({ source }) =>
    `From ${source}. Add one and it works on every machine.`,
  shelfAdd: 'Add',
  foundTitle: 'Found on your machines',
  foundBody:
    'Set up inside an agent, not in Happier yet. Add one and it follows you.',
  foundLine: ({ count, machine }) =>
    `${count} ${plural(count, 'server is', 'servers are')} already on ${machine}`,
  foundLineMachines: ({ count, machines }) =>
    `${count} ${plural(count, 'server is', 'servers are')} already on ${machines} machines`,
  foundLineBody:
    'Set up in your agents. Add them and they follow you to every machine.',
  review: 'Review',
  mapLabel: ({ count }) =>
    `${count} ${plural(count, 'MCP server', 'MCP servers')} around your Home`,
  more: ({ count }) => `+${count}`,
};

export const mcpHomeTranslations = {
  en,
} as const satisfies Pick<Record<string, McpHomeTranslation>, 'en'>;
