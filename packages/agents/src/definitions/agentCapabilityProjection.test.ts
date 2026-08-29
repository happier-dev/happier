import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../generated/bundledAgentDefinitions.js';
import {
  projectAgentCapabilitiesV2FromDefinition,
  type AgentDefinitionCapabilityFacts,
} from './agentCapabilityProjection.js';

const NO_CAPABILITIES: AgentDefinitionCapabilityFacts = {
  sessionCapabilities: {
    sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
    sessionRollback: { conversation: 'unsupported' },
  },
};

const MINIMAL_SESSIONS = {
  open: ['create', 'resume'],
  delivery: ['newTurn'],
  cancel: true,
} as const;

describe('projectAgentCapabilitiesV2FromDefinition', () => {
  it('derives the fork route from either fork fact the definition distinguishes', () => {
    const conversationOnly = projectAgentCapabilitiesV2FromDefinition({
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'unsupported' },
      },
    }, { sessions: MINIMAL_SESSIONS });
    const fromMessageOnly = projectAgentCapabilitiesV2FromDefinition({
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported', fromMessage: 'supported' },
        sessionRollback: { conversation: 'unsupported' },
      },
    }, { sessions: MINIMAL_SESSIONS });
    const neither = projectAgentCapabilitiesV2FromDefinition(NO_CAPABILITIES, {
      sessions: MINIMAL_SESSIONS,
    });

    expect(conversationOnly.sessions?.open).toEqual(['create', 'resume', 'fork']);
    expect(fromMessageOnly.sessions?.open).toEqual(['create', 'resume', 'fork']);
    expect(neither.sessions?.open).toEqual(['create', 'resume']);
  });

  it('projects conversation rollback only from the definition fact', () => {
    const rollsBack = projectAgentCapabilitiesV2FromDefinition({
      sessionCapabilities: {
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'supported' },
      },
    }, { sessions: MINIMAL_SESSIONS });

    expect(rollsBack.sessions?.conversationRollback).toBe(true);
    expect(projectAgentCapabilitiesV2FromDefinition(NO_CAPABILITIES, { sessions: MINIMAL_SESSIONS }).sessions)
      .not.toHaveProperty('conversationRollback');
  });

  it('projects check-now recovery only from the definition-owned executable readiness fact', () => {
    const supported = projectAgentCapabilitiesV2FromDefinition({
      sessionCapabilities: {
        ...NO_CAPABILITIES.sessionCapabilities,
        usageLimitRecovery: { checkNow: 'supported' },
      },
    }, { sessions: MINIMAL_SESSIONS });
    const unsupported = projectAgentCapabilitiesV2FromDefinition({
      sessionCapabilities: {
        ...NO_CAPABILITIES.sessionCapabilities,
        usageLimitRecovery: { checkNow: 'unsupported' },
      },
    }, { sessions: MINIMAL_SESSIONS });

    expect(supported.sessions?.usageLimitRecovery).toEqual({
      active: ['checkNow'],
      inactive: ['checkNow'],
    });
    expect(unsupported.sessions).not.toHaveProperty('usageLimitRecovery');
  });

  it('treats an experimental declaration as unsupported rather than advertising it', () => {
    const experimental = projectAgentCapabilitiesV2FromDefinition({
      sessionCapabilities: {
        sessionFork: { conversation: 'experimental', fromMessage: 'experimental' },
        sessionRollback: { conversation: 'experimental' },
      },
    }, { sessions: MINIMAL_SESSIONS });

    expect(experimental.sessions?.open).toEqual(['create', 'resume']);
    expect(experimental.sessions).not.toHaveProperty('conversationRollback');
  });

  it('emits the terminal surface for a terminal-hosted Agent and withholds it from every other attach strategy', () => {
    const project = (localControl: AgentDefinitionCapabilityFacts['localControl']) => (
      projectAgentCapabilitiesV2FromDefinition(
        { ...NO_CAPABILITIES, ...(localControl === undefined ? {} : { localControl }) },
        { surfaces: ['externalSessions'] },
      ).surfaces
    );

    expect(project({ supported: true, attachStrategy: 'terminal_host' })).toEqual(['terminal', 'externalSessions']);
    // Every Agent below is locally controllable, so `localControl.supported`
    // cannot be the fact that decides this: OpenCode attaches through its own
    // provider and Cursor/Kiro declare `unsupported`. None of them is a terminal
    // the daemon hosts, so the attach strategy is what discriminates.
    expect(project({ supported: true, attachStrategy: 'provider_attach' })).toEqual(['externalSessions']);
    expect(project({ supported: true, attachStrategy: 'unsupported' })).toEqual(['externalSessions']);
    expect(project({ supported: true })).toEqual(['externalSessions']);
    expect(project(null)).toEqual(['externalSessions']);
    expect(project(undefined)).toEqual(['externalSessions']);
  });

  it('withholds the terminal surface from a declaration that turns local control off', () => {
    // `supported` is the gate every other local-control reader already applies
    // (`getAgentLocalControlCapability` answers `null` without it, so the attach
    // command, the attach-state publisher and the local-control UI config all
    // treat the Agent as uncontrollable). A definition that switches local
    // control off but leaves a stale `attachStrategy` behind must not be the one
    // place that still advertises a terminal the daemon will never host.
    const project = (localControl: AgentDefinitionCapabilityFacts['localControl']) => (
      projectAgentCapabilitiesV2FromDefinition(
        { ...NO_CAPABILITIES, localControl },
        { surfaces: ['externalSessions'] },
      ).surfaces
    );

    expect(project({ supported: false, attachStrategy: 'terminal_host' })).toEqual(['externalSessions']);
    expect(project({ attachStrategy: 'terminal_host' })).toEqual(['externalSessions']);
    expect(project({ supported: true, attachStrategy: 'terminal_host' })).toEqual(['terminal', 'externalSessions']);
  });

  it('omits an empty capability block instead of declaring one', () => {
    expect(projectAgentCapabilitiesV2FromDefinition(NO_CAPABILITIES, {
      executionRuns: { open: ['create'], checkpoint: false, stop: true },
    })).toEqual({ executionRuns: { open: ['create'], checkpoint: false, stop: true } });
  });

  it('keeps Session-primary Agent projection exclusive from authored finite execution runs', () => {
    const projected = projectAgentCapabilitiesV2FromDefinition(NO_CAPABILITIES, {
      sessions: {
        open: ['create', 'resume'],
        delivery: ['newTurn', 'steer', 'followUp'],
        cancel: true,
        configuration: true,
        workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
      },
      executionRuns: { open: ['create'], checkpoint: true, stop: true },
    } as never);

    expect(projected.sessions).toMatchObject({
      delivery: ['newTurn', 'steer', 'followUp'],
      cancel: true,
      configuration: true,
      workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
    });
    expect(projected).not.toHaveProperty('executionRuns');
  });

  it('projects only declared tool-delivery modes from the Agent definition', () => {
    const project = (delivery: string) => projectAgentCapabilitiesV2FromDefinition({
      ...NO_CAPABILITIES,
      tools: { delivery },
    } as AgentDefinitionCapabilityFacts, {
      executionRuns: { open: ['create'], checkpoint: false, stop: true },
    });

    expect(project('native_mcp').tools).toEqual({ delivery: 'native_mcp' });
    expect(project('native_extension').tools).toEqual({ delivery: 'native_extension' });
    expect(project('shell_bridge').tools).toEqual({ delivery: 'shell_bridge' });
    expect(project('unsupported')).not.toHaveProperty('tools');
  });
});

type PublishedAgentContribution = Readonly<{
  id: string;
  capabilities: Readonly<Record<string, unknown>>;
}>;

/**
 * The capability blocks the bundled Agent plugins actually ship, read from
 * their published manifests so this stays a check against the shipped artifact
 * rather than against the source the projection already produces.
 */
function readPublishedBundledAgentContributions(): ReadonlyMap<string, PublishedAgentContribution> {
  const pluginsRoot = fileURLToPath(new URL('../../../plugins/', import.meta.url));
  const contributions = new Map<string, PublishedAgentContribution>();
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = `${pluginsRoot}${entry.name}/.happier-plugin/plugin.json`;
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contributes?: { agents?: readonly PublishedAgentContribution[] };
    };
    for (const agent of manifest.contributes?.agents ?? []) {
      // A plugin contribution local id is lower-case; the bundled Agent id it
      // stands for is not always (`ohMyPi`). Key on the case-folded id so this
      // check does not depend on that spelling.
      contributions.set(agent.id.toLowerCase(), agent);
    }
  }
  return contributions;
}

function withoutDefinitionOwnedFacts(capabilities: Readonly<Record<string, unknown>>): Readonly<{
  surfaces?: readonly string[];
  sessions?: Record<string, unknown>;
  executionRuns?: unknown;
}> {
  const surfaces = (capabilities.surfaces as readonly string[] | undefined)
    ?.filter((surface) => surface !== 'terminal');
  const publishedSessions = capabilities.sessions as Record<string, unknown> | undefined;
  const sessions = publishedSessions
    ? Object.fromEntries(
      Object.entries({
        ...publishedSessions,
        open: (publishedSessions.open as readonly string[]).filter((route) => route !== 'fork'),
      }).filter(([key]) => key !== 'conversationRollback'),
    )
    : undefined;
  return {
    ...(surfaces && surfaces.length > 0 ? { surfaces } : {}),
    ...(sessions ? { sessions } : {}),
    ...(capabilities.executionRuns ? { executionRuns: capabilities.executionRuns } : {}),
  };
}

describe('bundled Agent capability contributions', () => {
  it('are exactly what each Agent definition projects', () => {
    const published = readPublishedBundledAgentContributions();
    const definitions = BUNDLED_AGENT_DEFINITIONS_BY_ID as Readonly<Record<string, {
      id: string;
      core: AgentDefinitionCapabilityFacts;
    }>>;
    const definitionEntries = Object.values(definitions);
    expect(definitionEntries.length).toBeGreaterThan(0);

    for (const definition of definitionEntries) {
      const contribution = published.get(definition.id.toLowerCase());
      expect(contribution, `no published Agent contribution for '${definition.id}'`).toBeDefined();
      const projected = projectAgentCapabilitiesV2FromDefinition(
        definition.core,
        withoutDefinitionOwnedFacts(contribution!.capabilities) as never,
      );
      expect(projected, `capability drift for '${definition.id}'`).toEqual(contribution!.capabilities);
    }
  });
});
