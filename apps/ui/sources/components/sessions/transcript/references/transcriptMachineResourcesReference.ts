import {
  MachineProcessesAnswerV1Schema,
  type MachineProcessesAnswerV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { ToolCall } from '@happier-dev/session-core/messages';

import {
  readResourceProposalApproval,
  RESOURCE_PROPOSAL_ACTION_IDS,
  type ResourceProposalModel,
} from '@/components/approvals/resourceProposal/readResourceProposalApproval';

import {
  createHappierActionToolNameIndex,
  isRecord,
  readHappierActionCallInput,
  readHappierActionExecuteActionId,
  readHappierActionId,
  readHappierActionToolResultCandidates,
} from './happierActionToolResult';

/**
 * The one projection from a transcript tool call to a machine-resources tool body (plan 60 AGW-9 and
 * the A7 *analysing* state): a completed process census renders as the Processes tab's own rows, and
 * a set Action still being proposed renders the proposal frame. Matched by the Action spec's binding.
 */
const PROCESS_LIST =
  createHappierActionToolNameIndex<'machines.processes.list'>([
    'machines.processes.list',
  ]);
const PROPOSAL_IDS = RESOURCE_PROPOSAL_ACTION_IDS;
type ProposalActionId = (typeof PROPOSAL_IDS)[number];
const PROPOSALS =
  createHappierActionToolNameIndex<ProposalActionId>(PROPOSAL_IDS);

function isProcessList(id: string): id is 'machines.processes.list' {
  return id === 'machines.processes.list';
}
function isProposalId(id: string): id is ProposalActionId {
  return (PROPOSAL_IDS as readonly string[]).includes(id);
}

export type TranscriptMachineResourcesCall =
  | Readonly<{
      kind: 'processes';
      answer: MachineProcessesAnswerV1;
      machineId: string;
      serverId: string | null;
    }>
  | Readonly<{
      kind: 'proposing';
      actionId: ProposalActionId;
      proposal: ResourceProposalModel | null;
    }>;

export function readTranscriptMachineResourcesCall(
  tool: Pick<ToolCall, 'name' | 'input' | 'state' | 'result'>,
): TranscriptMachineResourcesCall | null {
  const listId =
    readHappierActionId(tool.name, PROCESS_LIST) ??
    readHappierActionExecuteActionId(tool.name, tool.input, isProcessList);
  if (listId) {
    if (tool.state !== 'completed') return null;
    const input = readHappierActionCallInput(tool.name, tool.input);
    const machineId =
      isRecord(input) && typeof input.machineId === 'string'
        ? input.machineId
        : null;
    if (!machineId) return null;
    for (const candidate of readHappierActionToolResultCandidates(
      tool.result,
      tool.input,
    )) {
      const parsed = MachineProcessesAnswerV1Schema.safeParse(candidate);
      if (parsed.success) {
        return {
          kind: 'processes',
          answer: parsed.data,
          machineId,
          serverId:
            isRecord(input) && typeof input.serverId === 'string'
              ? input.serverId
              : null,
        };
      }
    }
    return null;
  }
  const proposalId =
    readHappierActionId(tool.name, PROPOSALS) ??
    readHappierActionExecuteActionId(tool.name, tool.input, isProposalId);
  if (!proposalId || tool.state !== 'running') return null;
  // Rows from the call's input when the runtime has it; otherwise the frame reserves them.
  return {
    kind: 'proposing',
    actionId: proposalId,
    proposal: readResourceProposalApproval({
      actionId: proposalId,
      actionArgs: readHappierActionCallInput(tool.name, tool.input),
    }),
  };
}
