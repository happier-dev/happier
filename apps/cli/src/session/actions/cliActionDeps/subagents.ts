import type { ActionExecutorDeps, ActionCaller } from '@happier-dev/protocol';
import { HostSubagentStoreError, hostSubagentStore, type HostSubagentActor } from '@/session/subagents/hostSubagentStore';
import type { createSessionSubagentActivityReads } from '@/session/subagents/readSessionSubagentActivity';
function serializeHostSubagentStoreError(error: unknown): Readonly<{ ok: false; errorCode: string; error: string }> {
  if (error instanceof HostSubagentStoreError) {
    return { ok: false, errorCode: error.code, error: error.code };
  }
  throw error;
}

function deriveHostSubagentActor(caller: ActionCaller): HostSubagentActor {
  if (caller.kind !== 'plugin' || !caller.contributionLocalId?.trim()) {
    return { kind: 'externalRpc' };
  }
  return {
    kind: 'plugin',
    pluginId: caller.pluginId,
    agentId: caller.contributionLocalId,
  };
}

export function createCliSubagentActionDeps(
  reads: ReturnType<typeof createSessionSubagentActivityReads>,
): Pick<ActionExecutorDeps, 'subagentsList' | 'subagentsGet' | 'subagentsWatch' | 'subagentsUpsert' | 'subagentsUpdateStatus' | 'subagentsComplete'> {
  return {
    ...reads,

    subagentsWatch: async (args) => {
      try {
        return await new Promise((resolve, reject) => {
          try {
            let subscription: Readonly<{ unsubscribe(): void }> | null = null;
            let unsubscribeAfterRegister = false;
            subscription = hostSubagentStore.watch(args, (event) => {
              if (event.kind !== 'snapshot') return;
              resolve({
                kind: 'snapshot',
                subagents: event.subagents ?? [],
              });
              if (subscription) {
                subscription.unsubscribe();
              } else {
                unsubscribeAfterRegister = true;
              }
            });
            if (unsubscribeAfterRegister) {
              subscription.unsubscribe();
            }
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpsert: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.upsert({
          actor: deriveHostSubagentActor(caller),
          input,
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpdateStatus: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.updateStatus({
          ...input,
          actor: deriveHostSubagentActor(caller),
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsComplete: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.complete({
          ...input,
          actor: deriveHostSubagentActor(caller),
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },
  };
}

