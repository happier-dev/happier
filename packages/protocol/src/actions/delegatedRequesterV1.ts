/**
 * The one "acting for a person" fact (P3 M4, D13): an agent Session or MCP caller, or any
 * `account_automation` authority (API tokens, plugins, Workflows, automations). The database
 * access decider and the approval applier's database floor both consume this predicate, so a
 * caller admitted as an agent is always the caller the owner's agent level binds.
 */
export function isDelegatedActionRequesterV1(input: Readonly<{
  surface?: string;
  actionCaller?: Readonly<{ kind: string }> | null;
  authority?: string;
  /** The plugin host's admitted agent-caller fact, already folded from surface and caller. */
  agentCaller?: boolean;
}>): boolean {
  return input.agentCaller === true || input.surface === 'agent' || input.surface === 'mcp'
    || input.actionCaller?.kind === 'session' || input.authority === 'account_automation';
}
