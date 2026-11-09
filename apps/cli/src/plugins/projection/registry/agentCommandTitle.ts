import { readDeclaredAgentTitle } from '@happier-dev/agents/declaredAgentTitle';
import type { PluginAgentCliMetadata } from '@happier-dev/protocol';
import type { ResolvedAgentContribution } from './types';

/** Shared title for the runtime descriptor and its cold command projection. */
export function readAgentCommandTitle(params: Readonly<{
  agentId: string;
  title: unknown;
  cli: PluginAgentCliMetadata;
}>): string {
  return params.cli.displayName ?? readDeclaredAgentTitle(params.title) ?? params.agentId;
}

export function readResolvedAgentTitle(contribution: ResolvedAgentContribution): string {
    const runtimeTitle = contribution.runtimeSpec?.title;
    if (runtimeTitle) return runtimeTitle;
    return readDeclaredAgentTitle(contribution.richDefinition?.definition.title) ?? contribution.id;
}

