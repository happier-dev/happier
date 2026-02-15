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

function resolveDefaultBackendId(session: Session, enabledAgentIds: readonly string[]): string | null {
  const sessionAgent = (session as any)?.metadata?.agent;
  if (typeof sessionAgent === 'string' && enabledAgentIds.includes(sessionAgent)) return sessionAgent;
  return enabledAgentIds[0] ?? null;
}

export function SessionHeaderActionMenu(props: Readonly<{ sessionId: string; session: Session }>) {
  const { theme } = useUnistyles();
  const enabledAgentIds = useEnabledAgentIds();
  const actionsSettingsV1 = useSetting('actionsSettingsV1');
  const [open, setOpen] = React.useState(false);

  const actions = React.useMemo(() => {
    return listActionSpecs()
      .filter((spec) => spec.surfaces.ui_button === true)
      .filter((spec) => isActionEnabledInState(storage.getState() as any, spec.id))
      .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('session_action_menu' as any))
      .map((spec) => ({
        id: spec.id,
        title: spec.title,
        subtitle: spec.description,
      }));
  }, [actionsSettingsV1]);

  if (actions.length === 0) return null;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={actions}
      onSelect={(actionId) => {
        setOpen(false);
        const defaultBackendId = resolveDefaultBackendId(props.session, enabledAgentIds);
        if (!defaultBackendId) return;

        if (actionId === 'review.start') {
          storage.getState().createSessionActionDraft(props.sessionId, {
            actionId,
            input: {
              engineIds: [defaultBackendId],
              instructions: '',
              changeType: 'committed',
              base: { kind: 'none' },
            },
          });
          return;
        }

        if (actionId === 'plan.start' || actionId === 'delegate.start') {
          storage.getState().createSessionActionDraft(props.sessionId, {
            actionId,
            input: {
              backendIds: [defaultBackendId],
              instructions: '',
            },
          });
          return;
        }

        storage.getState().createSessionActionDraft(props.sessionId, {
          actionId,
          input: { backendIds: [defaultBackendId], instructions: '' },
        });
      }}
      trigger={({ toggle }) => (
        <Pressable
          onPress={toggle}
          hitSlop={15}
          accessibilityRole="button"
          accessibilityLabel="Open session actions"
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
