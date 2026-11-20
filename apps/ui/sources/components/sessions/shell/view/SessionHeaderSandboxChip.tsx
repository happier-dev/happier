import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_BADGE_METRICS,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { useSessionSandboxPlacement } from '@/hooks/session/useSessionSandboxPlacement';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

/**
 * The sandbox a Session runs in, named in its header after the folder ("Node 22 sandbox · devbox", lab machine-sandboxes
 * `firstsend-chip`). It opens the same managed resource detail a Machine's Sandboxes tab opens. The placement is the
 * Session's immutable birth record (display only); a Session that runs directly draws nothing.
 */
export const SessionHeaderSandboxChip = React.memo(
  function SessionHeaderSandboxChip(
    props: Readonly<{
      sessionId: string;
      serverId: string | null;
    }>,
  ) {
    const placement = useSessionSandboxPlacement(
      props.sessionId,
      props.serverId,
    );
    if (!placement || !props.serverId) return null;
    return (
      <SandboxChip
        serverId={props.serverId}
        managedId={placement.managedId}
        controllerMachineId={placement.controller?.machineId ?? null}
      />
    );
  },
);

function SandboxChip(
  props: Readonly<{
    serverId: string;
    managedId: string;
    controllerMachineId: string | null;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  // The managed inventory's own addressed read (shared with the detail it opens); presentation-gated by its owner.
  const inventory = useManagedMachineInventory(serverIds, props.managedId);
  const sandbox = Object.values(inventory.entries)[0]?.machines.find(
    (machine) => machine.id === props.managedId,
  );
  const host = useServerScopedMachine(
    props.serverId,
    props.controllerMachineId,
    (machine) => (machine ? getMachineSentenceName(machine) : null),
  );
  const name = sandbox?.launch?.name ?? t('common.machine');
  const label = host ? `${name} · ${host}` : name;
  const open = React.useCallback(() => {
    router.push(
      `/settings/machines/managed/${encodeURIComponent(props.managedId)}?serverId=${encodeURIComponent(props.serverId)}` as never,
    );
  }, [props.managedId, props.serverId, router]);
  return (
    <View style={styles.anchor}>
      <HappierPressable
        testID="session-header-sandbox-chip"
        accessibilityRole="link"
        accessibilityLabel={label}
        onPress={open}
        style={({ focused, pressed }) => [
          styles.chip,
          focusRingStyle({ focused, color: theme.colors.border.focus }),
          { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
        ]}
      >
        <StatusPill
          variant="neutral"
          label={label}
          accessibilityLabel={label}
          labelVariant="phrase"
          labelNumberOfLines={1}
          style={styles.anchor}
          leading={
            sandbox ? (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <ManagedPresetMark
                  serverId={props.serverId}
                  preset={{
                    launch: sandbox.launch,
                    controller: sandbox.controller,
                  }}
                  size={ICON_SIZE.xs}
                />
              </View>
            ) : undefined
          }
        />
      </HappierPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { flexShrink: 1, minWidth: 0 },
  chip: { flexShrink: 1, borderRadius: HAPPIER_BADGE_METRICS.radius },
});
