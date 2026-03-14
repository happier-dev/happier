import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listActionSpecs } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { storage, useSetting } from '@/sync/domains/state/storage';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import type { Session } from '@/sync/domains/state/storageTypes';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';

export function SessionHeaderActionMenu(props: Readonly<{ sessionId: string; session: Session }>) {
  const { theme } = useUnistyles();
  const enabledAgentIds = useEnabledAgentIds();
  const actionsSettingsV1 = useSetting('actionsSettingsV1');
  const sessionReplayEnabled = useSetting('sessionReplayEnabled');
  const [open, setOpen] = React.useState(false);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
    [],
  );

  const actions = React.useMemo(() => {
    return listActionSpecs()
      .filter((spec) => spec.surfaces.ui_button === true)
      .filter((spec) => isActionEnabledInState(storage.getState() as any, spec.id, { surface: 'ui_button', placement: 'session_action_menu' } as any))
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .filter((spec) => spec.id !== 'session.fork' || canForkConversation({ session: props.session, replayEnabled: sessionReplayEnabled }) === true)
      .map((spec) => ({
        id: spec.id,
        title: spec.title,
        subtitle: spec.description,
      }));
  }, [actionsSettingsV1, props.session, sessionReplayEnabled]);

  if (actions.length === 0) return null;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={actions}
      onSelect={(actionId) => {
        setOpen(false);
        if (actionId === 'session.fork') {
          fireAndForget((async () => {
            const res = await executor.execute(
              actionId as any,
              { sessionId: props.sessionId },
              { defaultSessionId: props.sessionId, surface: 'ui_button', placement: 'session_action_menu' } as any,
            );
            if (!res.ok) {
              Modal.alert(t('common.error'), String(res.error ?? t('errors.failedToForkSession')));
            }
          })(), { tag: 'SessionHeaderActionMenu.execute.sessionFork' });
          return;
        }
        const defaultBackend = resolveSessionActionDefaultBackend({
          session: props.session,
          enabledAgentIds,
        });
        if (!defaultBackend) return;
        const input = buildExecutionRunActionDraftInputForUi({
          actionId: actionId as any,
          sessionId: props.sessionId,
          defaultBackendTarget: defaultBackend.backendTarget,
          defaultBackendId: defaultBackend.defaultBackendId,
          instructions: '',
        });
        storage.getState().createSessionActionDraft(props.sessionId, { actionId, input });
      }}
      trigger={({ toggle }) => (
            <Pressable
              onPress={toggle}
              hitSlop={15}
              accessibilityRole="button"
              accessibilityLabel={t('session.actionMenu.openA11y')}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.header.tint} />
          </View>
        </Pressable>
      )}
      placement="bottom"
      variant="slim"
      rowKind="selectableRow"
      search={false}
      matchTriggerWidth={false}
      maxWidthCap={320}
    />
  );
}
