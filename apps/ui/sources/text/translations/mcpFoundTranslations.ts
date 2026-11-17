// "Found on your machines" for MCP servers (P7 §T6/§T9): the servers each machine's agents already have set
// up, grouped by machine and Agent. Mounted under `capabilities.mcpFound`.

export type McpFoundTranslation = Readonly<{
  purpose: string;
  checkAgain: string;
  add: string;
  inHappier: string;
  setUpIn: (params: Readonly<{ agent: string }>) => string;
  offIn: (params: Readonly<{ agent: string }>) => string;
  looking: string;
  nothingHere: string;
  lastKnown: (params: Readonly<{ time: string }>) => string;
  offlineBring: (params: Readonly<{ machine: string }>) => string;
  offlineUnseen: (params: Readonly<{ count: number }>) => string;
  scanFailed: (params: Readonly<{ machine: string }>) => string;
  tryAgain: string;
  olderMachine: (params: Readonly<{ machine: string }>) => string;
  noMachinesTitle: string;
  noMachinesBody: string;
  warningReadFailed: (params: Readonly<{ agent: string }>) => string;
  warningReadFailedNoAgent: string;
  warningParseFailed: (params: Readonly<{ agent: string }>) => string;
  warningParseFailedNoAgent: string;
  warningUnsupported: (params: Readonly<{ agent: string }>) => string;
  warningUnsupportedNoAgent: string;
  quietEmpty: (params: Readonly<{ count: number; others: boolean }>) => string;
  quietLooking: (params: Readonly<{ count: number }>) => string;
}>;

const en: McpFoundTranslation = {
  purpose: 'MCP servers your agents already have set up on each machine. Add one to Happier and every session gets it, on every machine.',
  checkAgain: 'Check again',
  add: 'Add',
  inHappier: 'In Happier',
  setUpIn: ({ agent }) => `Set up in ${agent}`,
  offIn: ({ agent }) => `Off in ${agent}`,
  looking: 'Looking…',
  nothingHere: 'No MCP servers found here.',
  lastKnown: ({ time }) => `last known ${time}`,
  offlineBring: ({ machine }) => `Bring ${machine} online to add from it.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 offline machine hasn't been looked at yet. Bring it online to see its MCP servers.`
      : `${count} offline machines haven't been looked at yet. Bring one online to see its MCP servers.`,
  scanFailed: ({ machine }) => `Couldn't read ${machine}'s MCP servers`,
  tryAgain: 'Try again',
  olderMachine: ({ machine }) => `${machine} needs a newer Happier to list its MCP servers.`,
  noMachinesTitle: 'No machines yet',
  noMachinesBody: 'Connect a machine to see the MCP servers your agents already have set up on it.',
  warningReadFailed: ({ agent }) => `Couldn't read ${agent}'s MCP settings`,
  warningReadFailedNoAgent: "Couldn't read an MCP settings file",
  warningParseFailed: ({ agent }) => `Couldn't understand ${agent}'s MCP settings`,
  warningParseFailedNoAgent: "Couldn't understand an MCP settings file",
  warningUnsupported: ({ agent }) => `Some of ${agent}'s MCP servers can't be read yet`,
  warningUnsupportedNoAgent: "Some MCP servers here can't be read yet",
  quietEmpty: ({ count, others }) => `No MCP servers found on ${count} ${others ? 'other ' : ''}${count === 1 ? 'machine' : 'machines'}`,
  quietLooking: ({ count }) =>
    `Looking on ${count} ${count === 1 ? 'machine' : 'machines'}…`,
};

export const mcpFoundTranslations = {
  en,
} as const;
