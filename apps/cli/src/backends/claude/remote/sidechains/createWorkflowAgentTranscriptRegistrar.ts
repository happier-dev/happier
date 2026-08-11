import type { ClaudeWorkflowAgentTranscriptRegistration } from '@/backends/claude/workflows/claudeWorkflowJournalFollower';

import type { ClaudeRemoteSubagentFileCollector } from './claudeRemoteSubagentFileCollector';

/**
 * The handover from the workflow journal follower to the ONE sidechain importer — fail-closed.
 *
 * The collector is built later in the launcher than the workflow source that feeds it, so the
 * source reaches it through a holder that is briefly null. Optional-chaining that holder reads as
 * "register, if convenient", and it resolves: the follower sees a successful registration, stamps a
 * `sidechainId` on the agent profile, and the row becomes pressable into a transcript that was
 * never imported. An id is a claim that something is openable, so the absence of an importer must
 * be a failure, not a shrug — the follower's own catch is what turns this throw back into
 * "no sidechain id yet", and a later journal entry retries.
 */
export function createWorkflowAgentTranscriptRegistrar(params: Readonly<{
  getCollector: () => ClaudeRemoteSubagentFileCollector | null;
}>): (registration: ClaudeWorkflowAgentTranscriptRegistration) => Promise<void> {
  return async (registration) => {
    const collector = params.getCollector();
    if (!collector) {
      throw new Error(
        `no sidechain importer is wired yet; refusing to claim ${registration.sidechainId}`,
      );
    }
    await collector.registerSidechainFile({
      sidechainId: registration.sidechainId,
      agentId: registration.agentId,
      filePath: registration.filePath,
      source: 'workflow-agent',
    });
  };
}
