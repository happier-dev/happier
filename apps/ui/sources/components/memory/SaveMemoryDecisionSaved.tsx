import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useProjectContext } from '@/components/projects/context/useProjectContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { randomUUID } from '@/platform/randomUUID';
import type { MemoryCreationReceipt } from '@/sync/ops/promptLibrary/memoryDocuments';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';

import { memoryDocumentHref } from './memoryDocumentRoutes';

/**
 * The decision is persisted but its Project Context did not take it yet. Say so, point at the saved fact
 * and offer the existing Context attach for that same document; never a second Remember.
 */
export function SaveMemoryDecisionSaved(
  props: Readonly<{
    receipt: MemoryCreationReceipt;
    /** The chosen Project; null for the person's own memory, which has only the link. */
    workspaceRef: WorkspaceRefV1 | null;
  /** The chosen Project's name, as the chooser shows it. */
  projectName: string;
    /** Leaving through the link or finishing the attach closes the sheet. */
    onDone: () => void;
  }>,
) {
  return (
    <View testID="save-memory-decision.saved" style={styles.root}>
      <View style={styles.titleRow}>
        <Icon name="seal-check" size={16} />
        <Text style={styles.title} accessibilityRole="header">
          {t('memoryContext.memory.sheetSavedUnattachedTitle')}
        </Text>
      </View>
      <Text style={styles.meta}>
        {t('memoryContext.memory.sheetSavedUnattachedBody')}
      </Text>
      {props.workspaceRef ? (
        <ProjectAttach {...props} workspaceRef={props.workspaceRef} />
      ) : (
        <OpenSaved {...props} />
      )}
    </View>
  );
}

function useOpenSaved(receipt: MemoryCreationReceipt, onDone: () => void) {
  const router = useRouter();
  return React.useCallback(() => {
    router.push(
      memoryDocumentHref(receipt.ref, { factId: receipt.factId }) as never,
    );
    onDone();
  }, [onDone, receipt.factId, receipt.ref, router]);
}

function OpenSaved(
  props: Readonly<{ receipt: MemoryCreationReceipt; onDone: () => void }>,
) {
  const open = useOpenSaved(props.receipt, props.onDone);
  return (
    <View style={styles.actions}>
      <RoundButton
        testID="save-memory-decision.openSaved"
        size="small"
        display="inverted"
        title={t('memoryContext.memory.sheetOpenSaved')}
        onPress={open}
      />
    </View>
  );
}

function ProjectAttach(
  props: Readonly<{
    receipt: MemoryCreationReceipt;
    workspaceRef: WorkspaceRefV1;
    projectName: string;
    onDone: () => void;
  }>,
) {
  const { receipt, workspaceRef, onDone } = props;
  const model = useProjectContext(workspaceRef);
  const open = useOpenSaved(receipt, onDone);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // The Source's documents when the Project has one, else the person's own Project layer.
  const shared = model.shared.status !== 'none';
  const ready = shared
    ? model.shared.status === 'ready' && model.shared.canManage
    : model.personal.available;
  const attach = React.useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const entry = {
        id: randomUUID(),
        ref: receipt.ref,
        enabled: true,
        placement: 'system_append' as const,
      };
      const outcome = shared
        ? await model.shared.update({
            kind: 'attach',
            attachment: { purpose: 'context', entry },
          })
        : await model.personal.update({ kind: 'attach', entry });
      if (outcome === 'applied') onDone();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [model.personal, model.shared, onDone, receipt.ref, shared]);
  return (
    <>
      {failed ? (
        <Text testID="save-memory-decision.attachFailed" style={styles.meta}>
          {t('memoryContext.memory.sheetAttachFailed')}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <RoundButton
          testID="save-memory-decision.openSaved"
          size="small"
          display="inverted"
          title={t('memoryContext.memory.sheetOpenSaved')}
          onPress={open}
        />
        <RoundButton
          testID="save-memory-decision.attach"
          size="small"
          display="secondary"
          disabled={!ready || busy}
          loading={busy}
          title={t('memoryContext.memory.sheetAttach', {
            project: props.projectName,
          })}
          action={attach}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s6,
    padding: theme.space.s12,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.inset,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  title: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  actions: { flexDirection: 'row', gap: theme.space.s8, flexWrap: 'wrap' },
}));
