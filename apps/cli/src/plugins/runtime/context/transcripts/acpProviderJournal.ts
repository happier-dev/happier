import type { AgentTranscriptFileFollowInput, AgentTranscriptFileFollowHandle } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginExecutionScopeV1 } from '@happier-dev/protocol';
import { createPluginTranscriptFileFollowService } from './fileFollow';
import { createTranscriptFileFollowPathGrantRegistry, type TranscriptFileFollowPathGrantRegistry } from './fileFollowGrants';

export type AcpProviderJournalFollower = (owner: Readonly<{
  providerSessionId: string;
  signal: AbortSignal;
}>, input: Omit<AgentTranscriptFileFollowInput, 'signal'>) => Promise<AgentTranscriptFileFollowHandle>;

export function createAcpProviderJournalFollower(params: Readonly<{
  pluginId: string;
  runtimeId: string;
  scope: PluginExecutionScopeV1;
  fileFollowPathGrants?: TranscriptFileFollowPathGrantRegistry;
}>): AcpProviderJournalFollower {
  const fileFollowPathGrants = params.fileFollowPathGrants ?? createTranscriptFileFollowPathGrantRegistry();
  const follow = createPluginTranscriptFileFollowService({ ...params,
    readScope: () => params.scope, fileFollowPathGrants });
  return async (owner, input) => {
    owner.signal.throwIfAborted();
    if (!owner.providerSessionId.trim()) throw new Error('ACP journal requires a native session identity');
    const grant = await fileFollowPathGrants.grant({
      pluginId: params.pluginId, runtimeId: params.runtimeId, scope: params.scope,
      path: input.path, reason: 'providerTranscriptSource',
      evidence: { kind: 'acpProviderSessionJournal', providerSessionId: owner.providerSessionId },
    });
    const revoke = () => { void grant.revoke(); };
    owner.signal.addEventListener('abort', revoke, { once: true });
    try {
      owner.signal.throwIfAborted();
      const handle = await follow.follow({ ...input, signal: owner.signal });
      if (owner.signal.aborted) {
        await handle.close({ finalDrain: false });
        owner.signal.throwIfAborted();
      }
      return Object.freeze({
        id: handle.id,
        drainNow: handle.drainNow,
        async close(options: Parameters<AgentTranscriptFileFollowHandle['close']>[0]) {
          owner.signal.removeEventListener('abort', revoke);
          await Promise.all([grant.revoke(), handle.close(options)]);
        },
      });
    } catch (error) {
      owner.signal.removeEventListener('abort', revoke);
      await grant.revoke();
      throw error;
    }
  };
}
