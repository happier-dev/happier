import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { AcpProviderTurnLifecycle } from '../../turn/providerTurns';

export type PublicProviderTurnEvidence =
  | Readonly<{ kind: 'provider-continuation-registered'; continuationId: string; parentTurnId: string; parentToolCallId: string }>
  | Readonly<{ kind: 'provider-continuation-released'; continuationId: string }>
  | Readonly<{ kind: 'provider-tool-contexts-released'; parentTurnId: string; toolCallIds: string[] }>;

/** Stores only the composer's admitted turn metadata; host witness admission is separate. */
export function createPublicProviderTurns<Parent extends Readonly<{ turnId: string }>>(params: Readonly<{
  isCurrent(): boolean;
  canBegin(): boolean;
  flush?(): Promise<void>;
  publish(event: PublicProviderTurnEvidence): void;
  begin(input: Readonly<{ parent: Parent; continuationId: string; agentTurnId: string }>): void;
}>): Readonly<{ capture(toolCallId: string, parent: Parent): void; lifecycle: AcpProviderTurnLifecycle }> {
  const parents = new Map<string, Parent | null>();
  const tasks = new Map<string, Parent | null>();
  /** Release captured parents by turn so the host can retire matching tool witnesses without affecting other admitted turns. */
  const releaseToolCalls = (ids: readonly string[]) => {
    const grouped = new Map<string, string[]>();
    for (const id of ids) {
      const parent = parents.get(id);
      parents.delete(id);
      if (!parent) continue;
      const group = grouped.get(parent.turnId) ?? [];
      group.push(id);
      grouped.set(parent.turnId, group);
    }
    for (const [parentTurnId, toolCallIds] of grouped) {
      params.publish({ kind: 'provider-tool-contexts-released', parentTurnId, toolCallIds });
    }
  };
  return {
    /** Retain the admitted parent snapshot; ambiguous tool identifiers cannot supply continuation authority. */
    capture(toolCallId, parent) {
      const previous = parents.get(toolCallId);
      // Observer identifiers must remain unambiguous across live source turns.
      if (previous && previous.turnId !== parent.turnId) {
        params.publish({ kind: 'provider-tool-contexts-released', parentTurnId: previous.turnId, toolCallIds: [toolCallId] });
        params.publish({ kind: 'provider-tool-contexts-released', parentTurnId: parent.turnId, toolCallIds: [toolCallId] });
        parents.set(toolCallId, null);
      } else if (previous === null) {
        params.publish({ kind: 'provider-tool-contexts-released', parentTurnId: parent.turnId, toolCallIds: [toolCallId] });
      } else {
        parents.set(toolCallId, parent);
      }
    },
    lifecycle: {
      foregroundActive: () => !params.canBegin(),
      flush: params.flush,
      /** Register each native task once against an unambiguous parent captured by the public composer. */
      registerContinuation({ id, parentToolCallId }) {
        const parent = parents.get(parentToolCallId);
        if (!params.isCurrent() || !readNonBlankOpaqueIdentifier(id) || !parent || tasks.has(id)) return false;
        tasks.set(id, parent);
        params.publish({ kind: 'provider-continuation-registered', continuationId: id, parentTurnId: parent.turnId, parentToolCallId });
        return true;
      },
      /** Consume registered parent metadata only when the composer is idle, preserving its admitted policy for the descendant. */
      beginContinuation({ id, turnId }) {
        const parent = tasks.get(id);
        if (!params.isCurrent() || !params.canBegin() || !parent || !readNonBlankOpaqueIdentifier(turnId)) return false;
        tasks.set(id, null);
        params.begin({ parent, continuationId: id, agentTurnId: turnId });
        return true;
      },
      releaseToolCalls,
      /** Revoke outstanding continuation and parent witnesses before discarding this source's captured metadata. */
      dispose() {
        for (const [continuationId, parent] of tasks) {
          if (parent) params.publish({ kind: 'provider-continuation-released', continuationId });
        }
        tasks.clear();
        releaseToolCalls([...parents.keys()]);
      },
    },
  };
}
