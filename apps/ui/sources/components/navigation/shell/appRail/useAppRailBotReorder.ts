import * as React from 'react';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionOrganizationMoveInput } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';

import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';
import { describeSessionListDropPreview, describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { readWindowBounds, useEntityDragDropRuntime, useEntityDragDomBinding, useEntityDropDomBinding } from '@/components/ui/treeDragDrop';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getStorage, readSessionOrganizationProjectionCached } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import type { AppRailBotEntry } from './appRailModel';

const execute = createFrontDoorActionExecute();

async function dispatchMove(input: SessionOrganizationMoveInput): Promise<EntityDropOutcomeV1> {
  const result = await execute('session.organization.move', input, {
    surface: 'ui', serverId: input.scope.serverId, expectedAccountId: input.scope.accountId,
  });
  const { projectActionOutcome } = await import('@/components/sessions/shell/useSessionListEntityDragDrop');
  return projectActionOutcome('session.organization.move', result);
}

function moveInput(binding: ServerCredentialAccountScopeBinding | undefined, serverId: string, sourceSessionId: string, targetSessionId: string, edge: 'top' | 'bottom'): SessionOrganizationMoveInput | null {
  if (!binding?.isCurrent() || binding.scope.serverId !== serverId) return null;
  return { scope: binding.scope, projection: 'rail', sourceKind: 'leaf',
    sourceRowId: treeRowId.session(serverId, sourceSessionId), targetRowId: treeRowId.session(serverId, targetSessionId),
    instructionKind: edge === 'top' ? 'reorder-before' : 'reorder-after',
    containerId: PINNED_GROUP_KEY_V1, parentRowId: null, depth: 0, edge };
}

/** The same qualified menu/keyboard command for visible and overflow rail pins. */
export async function moveAppRailBot(binding: ServerCredentialAccountScopeBinding | undefined, bot: AppRailBotEntry, targetSessionId: string, edge: 'top' | 'bottom') {
  const input = moveInput(binding, bot.serverId, bot.sessionId, targetSessionId, edge);
  const outcome = input ? await dispatchMove(input) : { status: 'refused' as const, reason: describeSessionListDropReason('unavailable') };
  if (outcome.status !== 'applied') Modal.alert(t('common.error'), outcome.reason.message);
}

/** Rail gestures produce semantic anchors only; the mounted Sessions adapter owns current order and writes. */
export function useAppRailBotReorder(bot: AppRailBotEntry) {
  const homeIds = React.useMemo(() => [bot.serverId], [bot.serverId]);
  const bindings = useServerCredentialAccountScopeBindings(homeIds);
  const binding = bindings.get(bot.serverId);
  const runtime = useEntityDragDropRuntime();
  const sourceId = React.useId();
  const targetId = `${sourceId}:order`;
  const host = React.useRef<unknown>(null);
  const latest = React.useRef({ bot, binding });
  latest.current = { bot, binding };

  const buildMove = React.useCallback((sourceSessionId: string, targetSessionId: string, edge: 'top' | 'bottom'): SessionOrganizationMoveInput | null => {
    const current = latest.current;
    return moveInput(current.binding, current.bot.serverId, sourceSessionId, targetSessionId, edge);
  }, []);
  const move = React.useCallback(async (targetSessionId: string, edge: 'top' | 'bottom') => {
    const current = latest.current;
    await moveAppRailBot(current.binding, current.bot, targetSessionId, edge);
  }, []);

  React.useEffect(() => {
    if (!binding) return;
    const scope = binding.scope;
    const isCurrent = () => latest.current.binding === binding && binding.isCurrent();
    const retireSource = runtime.registerSource({ id: sourceId, scope, isCurrent,
      getItem: () => isCurrent() ? { kind: 'session', scope, address: { serverId: bot.serverId, sessionId: bot.sessionId } } : null,
      describe: () => ({ title: getSessionName(latest.current.bot.session, bot.serverId) }),
      getBounds: () => readWindowBounds(host.current),
    });
    const retireTarget = runtime.registerTarget({ id: targetId, scope, acceptedKinds: ['session'], isCurrent,
      getBounds: () => readWindowBounds(host.current),
      resolve: ({ item, pointer }) => {
        if (item.kind !== 'session' || item.address.serverId !== bot.serverId || item.scope.accountId !== scope.accountId)
          return { status: 'refused', reason: describeSessionListDropReason('scope-mismatch') };
        const pins = readSessionOrganizationProjectionCached(getStorage().getState(), bot.serverId).railPinnedSessionIds;
        if (!pins.includes(item.address.sessionId)) return { status: 'refused', reason: describeSessionListDropReason('source-missing') };
        if (item.address.sessionId === bot.sessionId) return { status: 'refused', reason: describeSessionListDropReason('no-change') };
        const bounds = readWindowBounds(host.current);
        if (!pointer || !bounds) return { status: 'refused', reason: describeSessionListDropReason('no-target') };
        const edge = pointer.y < bounds.y + bounds.height / 2 ? 'top' : 'bottom';
        const input = buildMove(item.address.sessionId, bot.sessionId, edge);
        return input ? { status: 'allowed', effect: { actionId: 'session.organization.move', input,
          preview: describeSessionListDropPreview({ kind: 'reorder', edge: edge === 'top' ? 'above' : 'below',
            siblingName: getSessionName(latest.current.bot.session, bot.serverId) }) } }
          : { status: 'refused', reason: describeSessionListDropReason('unavailable') };
      },
      execute: async effect => {
        // The realm runtime revalidates this exact captured effect immediately before dispatch.
        const { SessionOrganizationMoveInputSchema } = await import('@happier-dev/protocol/actions/sessionOrganizationMoveAction');
        return dispatchMove(SessionOrganizationMoveInputSchema.parse(effect.input));
      },
    });
    return () => { retireTarget(); retireSource(); };
  }, [binding, bot.serverId, bot.sessionId, buildMove, runtime, sourceId, targetId]);
  const sourceRef = useEntityDragDomBinding({ runtime, sourceId, enabled: binding?.isCurrent() === true,
    describe: () => getSessionName(latest.current.bot.session, bot.serverId) });
  const dropRef = useEntityDropDomBinding(runtime);
  const ref = React.useCallback((node: unknown) => { host.current = node; sourceRef(node); dropRef(node); }, [dropRef, sourceRef]);
  return { move, ref, available: binding?.isCurrent() === true };
}
