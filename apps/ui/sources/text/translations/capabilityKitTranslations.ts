import { connectedAccountCallbackTranslations } from './connectedAccountCallbackTranslations';
import { skillsPageTranslations } from './skillsPageTranslations';
import { sessionCapabilityTranslations } from './sessionCapabilityTranslations';
import { capabilityNoticeTranslations } from './capabilityNoticeTranslations';
import { capabilityDetailTranslations } from './capabilityDetailTranslations';
import { skillDetailTranslations } from './skillDetailTranslations';
import { skillsFoundTranslations } from './skillsFoundTranslations';
import { mcpFoundTranslations } from './mcpFoundTranslations';
import { skillsUpdatesTranslations } from './skillsUpdatesTranslations';
import { mcpPageTranslations } from './mcpPageTranslations';
import { valueRefRowsTranslations } from './valueRefRowsTranslations';
import { mcpAddTranslations } from './mcpAddTranslations';
import { agentAddTranslations } from './agentAddTranslations';
import { mcpSignInTranslations } from './mcpSignInTranslations';
import { mcpHomeTranslations } from './mcpHomeTranslations';
import { agentsHomeTranslations } from './agentsHomeTranslations';
import { registriesTranslations, skillAddTranslations } from './registriesTranslations';
import { storeTranslations } from './storeTranslations';
import { profileSeedsTranslations } from './profileSeedsTranslations';
import { scopeSectionTranslations } from './scopeSectionTranslations';
// Shared capability UI kit copy (P5): "Where it's on" words and the capability status vocabulary.
// One block per locale; each locale root mounts its own block as `capabilities`.

export type CapabilityPlaceKind = 'machine' | 'project' | 'folder';
/** One clause's subject: an Agent, a place, or both ("for Gemini in happier"). */
export type CapabilityClauseParams = Readonly<{
  agent?: string;
  place?: string;
  placeKind?: CapabilityPlaceKind;
}>;
type ItemKind = Readonly<{ kind: 'skill' | 'mcp_server' }>;

export type CapabilityKitTranslation = Readonly<{
  where: Readonly<{
    onEverywhere: string;
    everywhere: string;
    off: string;
    only: (params: CapabilityClauseParams) => string;
    on: (params: CapabilityClauseParams) => string;
    except: (params: CapabilityClauseParams) => string;
    exceptions: (params: Readonly<{ count: number }>) => string;
    more: (params: Readonly<{ count: number }>) => string;
    effect: Readonly<{
      everywhereOn: string;
      everywhereOff: string;
      agentNever: (params: ItemKind) => string;
      agentEverywhereOn: string;
      machineOn: string;
      machineOff: string;
      projectOn: string;
      projectOff: string;
      folderOn: string;
      folderOff: string;
      agentAtOn: (
        params: Readonly<{
          agent: string;
          place: string;
          placeKind: CapabilityPlaceKind;
        }>,
      ) => string;
      agentAtOff: (
        params: Readonly<{
          agent: string;
          place: string;
          placeKind: CapabilityPlaceKind;
        }>,
      ) => string;
    }>;
    available: (
      params: Readonly<{ agents: string; machines: string; projects?: string }>,
    ) => string;
    availableNowhere: string;
    offlineNote: (params: Readonly<{ machine: string }>) => string;
    /** Several offline machines, said once. */
    offlineNoteMany: (params: Readonly<{ count: number }>) => string;
    cantTake: (params: Readonly<{ agent: string } & ItemKind>) => string;
  }>;
  control: Readonly<{
    title: string;
    description: string;
    everywhereLabel: string;
    on: string;
    off: string;
    turnedOnIn: string;
    except: string;
    nowhereYet: string;
    addException: string;
    addPlace: string;
    menuAgent: string;
    menuAgentEverywhere: string;
    menuMachine: string;
    menuProject: string;
    menuProjectEverywhere: string;
    offline: string;
    machineCount: (params: Readonly<{ count: number }>) => string;
    allAgents: string;
    agentOnly: (params: Readonly<{ agent: string }>) => string;
    whichAgents: (params: Readonly<{ place: string }>) => string;
    remove: (params: Readonly<{ target: string }>) => string;
    staysOff: (params: Readonly<{ agents: string }>) => string;
    change: string;
    changeFailed: string;
    checking: string;
  }>;
  add: Readonly<{
    closeDetails: string;
    backTo: (params: Readonly<{ title: string }>) => string;
    added: string;
    done: string;
    addFailed: string;
    modesLabel: string;
    searchLabel: string;
  }>;
  facts: Readonly<{
    textOnly: string;
    hasFiles: string;
    runsScripts: string;
    tokensWhenUsed: (params: Readonly<{ count: string }>) => string;
    toolCount: (params: Readonly<{ count: number; shown: string }>) => string;
    tokensPerTurn: (params: Readonly<{ count: string }>) => string;
    you: string;
    happier: string;
    pinnedTo: (params: Readonly<{ ref: string }>) => string;
    inYourLibrary: string;
  }>;
  status: Readonly<{
    off: string;
    signin: string;
    moreAccess: string;
    key: string;
    cantrun: (params: Readonly<{ machine?: string }>) => string;
    offline: string;
    update: string;
    removed: string;
    modified: string;
    pinned: string;
    unused: string;
    unusedExplanation: (params: Readonly<{ agents: string }>) => string;
    error: (params: Readonly<{ machine?: string }>) => string;
    masked: (params: Readonly<{ machine?: string }>) => string;
    signing: string;
    connected: string;
    expired: string;
    revoked: string;
    fix: Readonly<{
      signIn: string;
      reconnect: string;
      addKey: string;
      howToFix: string;
      tryAgain: string;
      reviewUpdate: string;
      compare: string;
      turnOn: string;
      grantAccess: string;
    }>;
  }>;
}>;

export const join = (...parts: readonly (string | false | undefined)[]) =>
  parts.filter(Boolean).join(' ');

const en: CapabilityKitTranslation = {
  where: {
    onEverywhere: 'On everywhere',
    everywhere: 'Everywhere',
    off: 'Off',
    only: ({ agent, place, placeKind }) =>
      join(
        'Only',
        agent && `for ${agent}`,
        place && `${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
      ),
    on: ({ agent, place, placeKind }) =>
      agent
        ? join(
            'on for',
            agent,
            place && `${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
          )
        : placeKind === 'machine'
          ? `on ${place}`
          : `on in ${place}`,
    except: ({ agent, place, placeKind }) =>
      join(
        'except',
        agent,
        place && `${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
      ),
    exceptions: ({ count }) =>
      count === 1 ? '1 exception' : `${count} exceptions`,
    more: ({ count }) => `${count} more`,
    effect: {
      everywhereOn: 'Every machine and agent, and the ones you add later',
      everywhereOff: 'Off unless a rule below turns it on',
      agentNever: ({ kind }) =>
        kind === 'skill'
          ? 'Never gets this skill, wherever it’s on'
          : 'Never gets this server, wherever it’s on',
      agentEverywhereOn: 'Gets it even where the rest is off',
      machineOn: 'Every agent on this machine',
      machineOff: 'No agent on this machine',
      projectOn: 'In this project, on every machine',
      projectOff: 'Not in this project, on any machine',
      folderOn: 'In this folder on this machine',
      folderOff: 'Not in this folder',
      agentAtOn: ({ agent, place, placeKind }) =>
        `${agent} gets it ${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
      agentAtOff: ({ agent, place, placeKind }) =>
        `${agent} doesn’t get it ${placeKind === 'machine' ? 'on' : 'in'} ${place}`,
    },
    available: ({ agents, machines, projects }) =>
      `Available to ${agents} on ${machines}${projects ? `, only in ${projects}` : ''}`,
    availableNowhere: 'Not available anywhere yet',
    offlineNote: ({ machine }) =>
      `${machine} is offline. It gets this when it’s back.`,
    offlineNoteMany: ({ count }) =>
      `${count} offline machines get it when they’re back.`,
    cantTake: ({ agent, kind }) =>
      kind === 'skill'
        ? `${agent} can’t load skills.`
        : `${agent} can’t use MCP servers.`,
  },
  control: {
    title: 'Where it’s on',
    description: 'Set it once and every machine follows. The most specific rule wins.',
    everywhereLabel: 'Everywhere on or off',
    on: 'On',
    off: 'Off',
    turnedOnIn: 'Turned on in',
    except: 'Except',
    nowhereYet: 'Nowhere yet. Add a project, a machine or an agent.',
    addException: 'Add an exception',
    addPlace: 'Add a place',
    menuAgent: 'An agent',
    menuAgentEverywhere: 'An agent, everywhere',
    menuMachine: 'A machine',
    menuProject: 'A project',
    menuProjectEverywhere: 'A project, on every machine',
    offline: 'offline',
    machineCount: ({ count }) => count === 1 ? '1 machine' : `${count} machines`,
    allAgents: 'All agents',
    agentOnly: ({ agent }) => `${agent} only`,
    whichAgents: ({ place }) => `Which agents in ${place}`,
    remove: ({ target }) => `Remove the rule for ${target}`,
    staysOff: ({ agents }) => `${agents} stays off here`,
    change: 'Change',
    changeFailed: 'Couldn’t save that change.',
    checking: 'Checking machines…',
  },
  add: {
    closeDetails: 'Close details',
    backTo: ({ title }) => `Back to ${title}`,
    added: 'Added',
    done: 'Done',
    addFailed: 'Couldn’t add it. Try again.',
    modesLabel: 'Ways to add',
    searchLabel: 'Search',
  },
  facts: {
    textOnly: 'Text only',
    hasFiles: 'Has files',
    runsScripts: 'Runs scripts',
    tokensWhenUsed: ({ count }) => `${count} tokens`,
    toolCount: ({ count, shown }) => (count === 1 ? `${shown} tool` : `${shown} tools`),
    tokensPerTurn: ({ count }) => `${count} tokens a turn`,
    you: 'You',
    happier: 'Happier',
    pinnedTo: ({ ref }) => `Pinned to ${ref}`,
    inYourLibrary: 'In your library',
  },
  status: {
    off: 'Off',
    signin: 'Needs sign-in',
    moreAccess: 'Needs more access',
    key: 'Needs a key',
    cantrun: ({ machine }) =>
      machine ? `Can’t run on ${machine}` : 'Can’t run',
    offline: 'Offline',
    update: 'Update available',
    removed: 'Removed from source',
    modified: 'Modified',
    pinned: 'Pinned',
    unused: 'Not used recently',
    unusedExplanation: ({ agents }) =>
      `Use is recorded for ${agents} and agents that read skills through Happier`,
    error: ({ machine }) =>
      machine ? `Stopped on ${machine}` : 'Couldn’t start',
    masked: ({ machine }) =>
      machine ? `${machine}’s copy wins` : 'Another copy wins',
    signing: 'Signing in…',
    connected: 'Connected',
    expired: 'Sign-in expired',
    revoked: 'Access revoked',
    fix: {
      signIn: 'Sign in',
      reconnect: 'Reconnect',
      addKey: 'Add a key',
      howToFix: 'How to fix',
      tryAgain: 'Try again',
      reviewUpdate: 'Review update',
      compare: 'Compare',
      turnOn: 'Turn on',
      grantAccess: 'Grant access',
    },
  },
};

// The Skills page family's copy rides in each locale's `capabilities` block as `capabilities.skills`.
export const capabilityKitTranslations = {
  en: { ...en, skills: skillsPageTranslations.en, session: sessionCapabilityTranslations.en, notice: capabilityNoticeTranslations.en, detail: capabilityDetailTranslations.en, skillDetail: skillDetailTranslations.en, skillsFound: skillsFoundTranslations.en, mcpFound: mcpFoundTranslations.en, skillsUpdates: skillsUpdatesTranslations.en, mcp: mcpPageTranslations.en, valueRows: valueRefRowsTranslations.en, mcpSignIn: mcpSignInTranslations.en, connectedAccountCallback: connectedAccountCallbackTranslations.en, mcpHome: mcpHomeTranslations.en, registries: registriesTranslations.en, skillAdd: skillAddTranslations.en, mcpAdd: mcpAddTranslations.en, agentAdd: agentAddTranslations.en, agentsHome: agentsHomeTranslations.en, profileSeeds: profileSeedsTranslations.en, scopeSection: scopeSectionTranslations.en, store: storeTranslations.en },
} as const;
