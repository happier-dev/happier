import { t } from '@/text';

import type { SkillMachineTruth } from './useSkillMachineTruth';

/**
 * The closed line of "On your machines": which Agents get the skill, named once, and on how many machines
 * ("Claude, Codex on 12 machines"; one machine is named), and apart from it, how many machines are offline.
 * Which machine gives which Agent is the open rows' job.
 */
export function summarizeMachines(
  shown: readonly SkillMachineTruth[],
  agentNames: (agentIds: readonly string[]) => readonly string[],
): Readonly<{ summary: string; note: string | undefined }> {
  const online = shown.filter((entry) => entry.machine.online === true);
  const offline = shown.filter((entry) => entry.machine.offline).length;
  const agents = new Set<string>();
  const machines: string[] = [];
  let pending = false;
  for (const entry of online) {
    const delivered = entry.skillAgents.filter((agentId) => entry.facts.get(agentId)?.kind === 'delivered');
    if (entry.skillAgents.some((agentId) => (entry.facts.get(agentId) ?? { kind: 'pending' }).kind === 'pending')) pending = true;
    if (delivered.length === 0) continue;
    for (const agentId of delivered) agents.add(agentId);
    machines.push(entry.machine.name ?? entry.machine.machineId);
  }
  const clauses: string[] = [];
  if (machines.length > 0) {
    const names = agentNames([...agents]).join(', ');
    clauses.push(
      machines.length === 1
        ? t('capabilities.skillDetail.machines.summaryOn', { agents: names, machine: machines[0]! })
        : t('capabilities.skillDetail.machines.summaryOnMany', { agents: names, count: machines.length }),
    );
  }
  if (clauses.length === 0 && online.length > 0)
    clauses.push(t(pending ? 'capabilities.skillDetail.machines.checking' : 'capabilities.skillDetail.machines.nowhere'));
  if (clauses.length === 0 && shown.some(entry => entry.machine.online === null))
    clauses.push(t('common.unknown'));
  return {
    summary: clauses.join(' · '),
    note: offline > 0 ? t('capabilities.skillDetail.machines.offlineCount', { count: offline }) : undefined,
  };
}
