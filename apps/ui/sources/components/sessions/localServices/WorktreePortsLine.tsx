import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { WorktreePortsResultV1 } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';

import { createProjectManifestActionClient } from '@/components/projects/projectSetup/projectManifestActionClient';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

type Unavailable = Extract<WorktreePortsResultV1, { kind: 'unavailable' }>;

/** The ports owner's typed refusal, in words; never a local guess about what is running. */
function describeUnavailable(result: Unavailable): string {
  if (result.code === 'project_worktree_ports_active')
    return t('localServices.worktreePorts.active');
  if (result.code === 'cancelled')
    return t('localServices.worktreePorts.cancelled');
  return t('localServices.worktreePorts.unavailable');
}

/**
 * One line under the scope bar for a workspace whose project gives each checkout its own ports (lab L8 proposed):
 * the ports this checkout holds, and "Choose new ports…" behind the designed confirmation. The ports owner
 * (`projects.worktree.ports.reassign`) is the stopped-only authority; a refusal comes back typed and is said here.
 */
export const WorktreePortsLine = React.memo(function WorktreePortsLine(
  props: Readonly<{
    result: WorktreePortsResultV1;
    workspace: ProjectDefinitionWorkspace | null;
    onReassigned?: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { binding } = useServerCredentialAccountScopeBinding(
    props.workspace?.serverId ?? null,
  );
  const [pending, setPending] = React.useState(false);
  const { workspace, onReassigned } = props;
  const accountId = binding?.accountId ?? null;
  const chooseNewPorts = React.useCallback(async () => {
    if (!workspace || !accountId || pending) return;
    const confirmed = await Modal.confirm(
      t('localServices.worktreePorts.confirmTitle'),
      t('localServices.worktreePorts.confirmMessage'),
      { confirmText: t('localServices.worktreePorts.confirmCta') },
    );
    if (!confirmed) return;
    setPending(true);
    try {
      const client = createProjectManifestActionClient({
        workspace,
        expectedAccountId: accountId,
      });
      const outcome = await client.reassignWorktreePorts({ confirmed: true });
      if (outcome.kind === 'unavailable') {
        Modal.alert(
          t('localServices.worktreePorts.failedTitle'),
          describeUnavailable(outcome),
        );
      } else {
        onReassigned?.();
      }
    } catch {
      Modal.alert(
        t('localServices.worktreePorts.failedTitle'),
        t('errors.tryAgain'),
      );
    } finally {
      setPending(false);
    }
  }, [accountId, onReassigned, pending, workspace]);
  const ready = props.result.kind === 'ready' ? props.result : null;
  const ports = ready
    ? [...new Set(ready.assignment.ports)].sort((a, b) => a - b)
    : [];
  const sentence = ready
    ? ports.length > 0
      ? t('localServices.worktreePorts.own', { ports: ports.join(', ') })
      : t('localServices.worktreePorts.ownNone')
    : describeUnavailable(props.result as Unavailable);
  return (
    <View testID={props.testID} style={styles.line}>
      <Icon
        name="globe"
        size={ICON_SIZE.sm}
        color={
          ready
            ? theme.colors.text.secondary
            : theme.colors.state.warning.foreground
        }
      />
      {/* The sentence wraps beside its mark; the link follows it on the same line when there is room. */}
      <View style={styles.body}>
        <Text style={styles.text} variant="meta">
          {sentence}
        </Text>
        {workspace && accountId ? (
          <TextLinkButton
            testID={`${props.testID}-reassign`}
            label={t('localServices.worktreePorts.reassign')}
            tone="quiet"
            size="meta"
            disabled={pending}
            onPress={() => {
              void chooseNewPorts();
            }}
          />
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // Under the scope bar, on its inset.
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    marginHorizontal: theme.space.s16,
    marginTop: theme.space.s4,
    marginBottom: theme.space.s8,
  },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
  },
  text: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
}));
