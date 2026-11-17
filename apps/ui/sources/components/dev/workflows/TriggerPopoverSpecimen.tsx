import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TriggerPopover } from '@/components/workflows/triggers/TriggerPopover';
import { TriggerRunsOnRow } from '@/components/workflows/triggers/TriggerRunsOnRow';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { TriggerFormValue } from '@/components/workflows/triggers/sessionTriggerForm';
import { t } from '@/text';

const noopAsync = async () => {};
const noop = () => {};

type Scene = 'daily' | 'hourly' | 'new';

const FORMS: Readonly<Record<Exclude<Scene, 'new'>, TriggerFormValue>> = {
  daily: {
    enabled: true,
    when: {
      kind: 'schedule',
      schedule: { repeat: 'daily', hour: 2, minute: 0, day: 1 },
      expression: '0 2 * * *',
      timezone: 'Europe/Zurich',
    },
    then: {
      kind: 'notifyMe',
      title: 'Nightly release check',
      message: 'The release build finished.',
      channels: [],
    },
  },
  hourly: {
    enabled: true,
    when: {
      kind: 'schedule',
      schedule: { repeat: 'hourly', hour: 9, minute: 54, day: 1 },
      expression: '54 * * * *',
      timezone: 'Europe/Zurich',
    },
    then: {
      kind: 'notifyMe',
      title: 'Inbox sweep',
      message: 'Anything new that needs me?',
      channels: [],
    },
  },
};

/**
 * Dev-only: the real trigger popover on a saved Account schedule (`?scene=daily|hourly|new`), anchored
 * under a button the way a Library row anchors it. Never linked from product surfaces.
 */
export function TriggerPopoverSpecimen(props: Readonly<{ scene: Scene }>) {
  const anchorRef = React.useRef<View>(null);
  const [open, setOpen] = React.useState(true);
  // The Account host's Runs on row, on this Account's real Machines (AccountTriggersSection).
  const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
  return (
    <View style={styles.page} testID="trigger-popover-specimen">
      <View ref={anchorRef} collapsable={false} style={styles.anchor}>
        <RoundButton
          size="small"
          display="secondary"
          title={t('common.open')}
          onPress={() => setOpen(true)}
        />
      </View>
      {open ? (
        <TriggerPopover
          testID="trigger-popover-specimen-popover"
          anchorRef={anchorRef}
          onRequestClose={() => setOpen(false)}
          whenKinds={['schedule', 'pluginEvent']}
          sessionId={null}
          initial={props.scene === 'new' ? null : FORMS[props.scene]}
          {...(props.scene === 'new'
            ? {}
            : {
                subtitle: props.scene === 'hourly' ? 'Next: in 22 min' : 'Next: tonight at 02:00',
                onHistory: noop,
                onToggleEnabled: { enabled: true, onPress: noop },
                onDelete: noopAsync,
              })}
          workflowOptions={[]}
          hostComplete={project !== null}
          setRows={
            <TriggerRunsOnRow
              testID="trigger-popover-specimen-runs-on"
              target={project}
              onChange={setProject}
              description={t('workflows.triggers.editor.runsOnAccountDescription')}
            />
          }
          machineId={null}
          onSubmit={noopAsync}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
    padding: theme.space.s16,
  },
  anchor: { alignSelf: 'flex-end', marginRight: theme.space.s16 * 6 },
}));
