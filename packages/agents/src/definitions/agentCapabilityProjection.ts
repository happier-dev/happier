import type {
  PluginAgentCapabilitiesV2,
  PluginAgentCapabilitySurfaceV2,
  PluginAgentExecutionRunCapabilitiesV2,
  PluginAgentSessionCapabilitiesV2,
  PluginAgentToolsCapabilityV2,
} from '@happier-dev/protocol';

/**
 * An Agent definition is authored as plain data whose string literals widen, so
 * the read side below takes plain `string`: every read compares against an
 * exact member and treats anything else as undeclared. The authored side keeps
 * its exact vocabulary in `../types.js`; restating it here bought no checking
 * (each alias was a `| (string & {})` widening, i.e. `string`) and only made
 * the projector's public signature depend on host-internal names.
 */

/**
 * The capability facts a bundled Agent's own definition already owns.
 *
 * A bundled Agent declares fork, conversation rollback, terminal hosting and
 * tool delivery once, in `AGENT_DEFINITION.core`. Its plugin manifest used to
 * restate the same facts in the V2 contribution vocabulary, which made the plugin
 * package hold two writers for one concept and left drift only a typo away.
 * This is the read side of the single writer.
 */
export type AgentDefinitionCapabilityFacts = Readonly<{
  sessionCapabilities: Readonly<{
    sessionFork: Readonly<{
      conversation: string;
      fromMessage: string;
    }>;
    sessionRollback: Readonly<{
      conversation: string;
    }>;
  }>;
  localControl?: AgentLocalControlDeclaration | null;
  tools?: Readonly<{
    delivery?: string;
  }> | null;
}>;

/**
 * The local-control facts that decide whether the host hosts this Agent's
 * terminal. `supported` is required on the authored
 * {@link import('../types.js').AgentLocalControlConfig}; it is optional here
 * only because this projection reads structurally, and an absent flag is read
 * as "not switched on" exactly like every other reader treats it.
 */
export type AgentLocalControlDeclaration = Readonly<{
  supported?: boolean;
  attachStrategy?: string;
}>;

/** Session-opening routes an Agent manifest still authors for itself. */
export type AuthoredAgentSessionOpenRouteV2 = Exclude<
  PluginAgentSessionCapabilitiesV2['open'][number],
  'fork'
>;

/** Capability surfaces an Agent manifest still authors for itself. */
export type AuthoredAgentCapabilitySurfaceV2 = Exclude<PluginAgentCapabilitySurfaceV2, 'terminal'>;

/**
 * Everything a bundled Agent manifest still declares itself.
 *
 * The definition-owned facts are absent from this type on purpose: the
 * compiler, not a review convention, is what stops a manifest from stating
 * `'fork'`, `conversationRollback`, tool delivery or the `'terminal'` surface
 * a second time.
 */
export type AuthoredAgentSessionCapabilitiesV2 =
  & Omit<PluginAgentSessionCapabilitiesV2, 'open' | 'conversationRollback'>
  & Readonly<{ open: readonly AuthoredAgentSessionOpenRouteV2[] }>;

export type AuthoredAgentCapabilitiesV2 = Readonly<{
  surfaces?: readonly AuthoredAgentCapabilitySurfaceV2[];
  sessions?: AuthoredAgentSessionCapabilitiesV2;
  executionRuns?: PluginAgentExecutionRunCapabilitiesV2;
}>;

function declaresSessionFork(facts: AgentDefinitionCapabilityFacts): boolean {
  const { sessionFork } = facts.sessionCapabilities;
  return sessionFork.conversation === 'supported' || sessionFork.fromMessage === 'supported';
}

function declaresConversationRollback(facts: AgentDefinitionCapabilityFacts): boolean {
  return facts.sessionCapabilities.sessionRollback.conversation === 'supported';
}

/**
 * Whether the host runs this Agent's process under its own terminal.
 *
 * This is the single owner of that rule: `usesTerminalHostedLocalControl`
 * delegates here, so an Agent-keyed answer and the `terminal` surface that
 * Agent's packaged manifest ships cannot disagree. The `supported` gate below is
 * the same one `getAgentLocalControlCapability` applies, which is how every
 * other local-control reader — the attach command, the attach-state publisher,
 * the local-control UI config — already decides an Agent is uncontrollable.
 *
 * Two facts decide it, and both are load-bearing. `supported` is the switch: a
 * declaration that turns local control off must not advertise a terminal on the
 * strength of a stale attach strategy. `attachStrategy` then discriminates
 * among the Agents that *are* locally controllable, because `supported` alone is
 * true for Agents the host does not host a terminal for — OpenCode attaches
 * through its own provider, Cursor and Kiro declare `unsupported`. The V2
 * `terminal` surface is exactly what provisions the daemon's `terminalRuntime`
 * family and `terminalHost` service, which is why neither fact alone is enough.
 */
export function localControlDeclarationHostsTerminal(
  localControl: AgentLocalControlDeclaration | null | undefined,
): boolean {
  return localControl?.supported === true && localControl.attachStrategy === 'terminal_host';
}

function hostsTerminal(facts: AgentDefinitionCapabilityFacts): boolean {
  return localControlDeclarationHostsTerminal(facts.localControl);
}

function projectToolsCapability(
  facts: AgentDefinitionCapabilityFacts,
): PluginAgentToolsCapabilityV2 | null {
  const delivery = facts.tools?.delivery;
  if (
    delivery !== 'native_mcp'
    && delivery !== 'native_extension'
    && delivery !== 'shell_bridge'
  ) {
    return null;
  }
  return { delivery };
}

/**
 * Projects a bundled Agent's V2 capability contribution from its own definition.
 *
 * The definition is the strictly richer table — it distinguishes conversation
 * fork from from-message fork and refines every fact per runtime kind — so the
 * projection runs definition → manifest and never the reverse. Facts V2 owns
 * and the definition does not (cancel, goals, catalog, execution runs, the
 * external-sessions surface, …) stay authored in the manifest and are
 * carried through untouched.
 */
export function projectAgentCapabilitiesV2FromDefinition(
  facts: AgentDefinitionCapabilityFacts,
  authored: AuthoredAgentCapabilitiesV2 & Readonly<{ sessions: AuthoredAgentSessionCapabilitiesV2 }>,
): PluginAgentCapabilitiesV2 & Readonly<{ sessions: PluginAgentSessionCapabilitiesV2 }>;
export function projectAgentCapabilitiesV2FromDefinition(
  facts: AgentDefinitionCapabilityFacts,
  authored: AuthoredAgentCapabilitiesV2 & Readonly<{ executionRuns: PluginAgentExecutionRunCapabilitiesV2 }>,
): PluginAgentCapabilitiesV2 & Readonly<{ executionRuns: PluginAgentExecutionRunCapabilitiesV2 }>;
export function projectAgentCapabilitiesV2FromDefinition(
  facts: AgentDefinitionCapabilityFacts,
  authored: AuthoredAgentCapabilitiesV2,
): PluginAgentCapabilitiesV2 {
  const surfaces: PluginAgentCapabilitySurfaceV2[] = [
    ...(hostsTerminal(facts) ? (['terminal'] as const) : []),
    ...(authored.surfaces ?? []),
  ];

  const sessions: PluginAgentSessionCapabilitiesV2 | null = authored.sessions
    ? {
      ...authored.sessions,
      open: [
        ...authored.sessions.open,
        ...(declaresSessionFork(facts) ? (['fork'] as const) : []),
      ],
      ...(declaresConversationRollback(facts) ? { conversationRollback: true as const } : {}),
    }
    : null;
  const tools = projectToolsCapability(facts);

  return {
    ...(surfaces.length > 0 ? { surfaces } : {}),
    ...(sessions ? { sessions } : {}),
    ...(authored.executionRuns ? { executionRuns: authored.executionRuns } : {}),
    ...(tools ? { tools } : {}),
  };
}
