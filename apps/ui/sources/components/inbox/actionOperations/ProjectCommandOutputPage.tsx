import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  happierPageTextMetrics,
  joinHappierFacts,
} from '@happier-dev/plugin-ui/presentation';

import {
  RunClock,
  RunGlyph,
} from '@/components/projects/projectSetup/ProjectRunMarks';
import { presentProjectRun, projectRunStatusTone } from '@/components/projects/projectSetup/projectScriptPresentation';
import { rowStatusToneColors } from '@/components/ui/status/RowStatusLine';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { useServerScopedMachine, useWorkspaceRefs } from '@/sync/store/hooks';
import { t } from '@/text';
import { inferProjectTitleFromPath } from '@/utils/path/browseSegments';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

import { readActionOperationOutputAttachment } from './actionOperationDetailPresentation';
import { openActionOperationDetail } from './openActionOperationDetail';
import { ProjectCommandOutputFrame } from './ProjectCommandOutputFrame';
import { ProjectCommandOutputPane } from './ProjectCommandOutputPane';
import { useActionOperationStopControl } from './useActionOperationStopControl';

export type ProjectCommandOutputPageProps = CustomModalInjectedProps &
  Readonly<{
    serverId: string;
    operationId: string;
    /** The script's name ("test", "Setup"): the page title. */
    name: string;
    /** What runs, as declared; omitted when the caller has no declaration for it. */
    command: string | null;
  }>;

/**
 * A project command's output as its own page on a phone (lab `s-scripts` OUTPUTp): the script, how its
 * run is going or went and where, what runs, and the same retained terminal the wide row discloses.
 * The operation stays live while the page is open; Stop is the page's only action while it runs.
 */
export const ProjectCommandOutputPage = React.memo(
  function ProjectCommandOutputPage(props: ProjectCommandOutputPageProps) {
    const { theme } = useUnistyles();
    const operation = useActionOperation(
      actionOperationAddress(props.serverId, props.operationId),
    );
    const attachment = operation
      ? readActionOperationOutputAttachment(operation.snapshot)
      : null;
    const target = useServerScopedMachine(
      attachment?.serverId ?? props.serverId,
      attachment?.machineId ?? '',
    );
    const machineName =
      (target ? getMachineSentenceName(target) : null) ??
      attachment?.machineId ??
      null;
    const presentation = presentProjectRun(operation ?? null, machineName, '');
    const workspaceRefs = useWorkspaceRefs();
    const projectName = React.useMemo(() => {
      if (attachment?.kind !== 'projectCommand') return null;
      const resolved = resolveWorkspaceRefById(
        workspaceRefs,
        attachment.workspaceRefId,
        attachment.serverId,
      );
      return resolved.kind === 'resolved'
        ? resolved.ref.label ?? inferProjectTitleFromPath(resolved.ref.rootPath)
        : null;
    }, [attachment, workspaceRefs]);
    // The machine is the status line's to name (lab OUTPUTp: status carries the worker, subtitle the project).
    const subtitle = joinHappierFacts(t('projects.pages.scripts'), projectName);
    const stop = useActionOperationStopControl(operation);
    const [outputHeight, setOutputHeight] = React.useState<number | null>(null);
    const { setChrome } = props;

    React.useEffect(() => {
      setChrome?.({
        kind: 'card',
        title: props.name,
        subtitle,
        subtitleLines: 1,
        testID: 'project-command-output-page',
        phonePresentation: 'fullscreen',
        scrollHost: 'body',
        bodyScroll: 'none',
      });
      return () => setChrome?.(null);
    }, [props.name, setChrome, subtitle]);

    const stopping = stop.pending || stop.stopRequested;
    const status = stopping ? t('projects.scripts.run.stopping') : presentation.text;
    // The page's own status line reads larger than a row's, but its trouble inks are the row status line's.
    const statusTone = projectRunStatusTone(presentation.tone);
    const statusColor = statusTone === 'quiet' ? theme.colors.text.primary : rowStatusToneColors(theme)[statusTone];
    const canStop =
      presentation.live && operation?.snapshot.cancellation === 'supported';
    const onOutputLayout = React.useCallback((event: LayoutChangeEvent) => {
      const next = Math.floor(event.nativeEvent.layout.height);
      setOutputHeight((previous) => (previous === next ? previous : next));
    }, []);

    if (!operation) {
      return (
        <View style={[styles.page, styles.empty]} testID="project-command-output-page.body">
          <SurfaceStateCard size="line" kind="unavailable" title={t('inbox.actionOperations.unavailableTitle')}
            reason={t('inbox.actionOperations.unavailableDescription')} testID="project-command-output-page.unavailable" />
        </View>
      );
    }
    const emptyOutput = isActionOperationTerminal(operation.snapshot.state) ? (
      <View style={styles.empty}>
        <SurfaceStateCard size="line" kind="empty" title={t('tools.fullView.noOutput')}
          testID="project-command-output-page.noOutput" />
      </View>
    ) : null;

    return (
      <View style={styles.page} testID="project-command-output-page.body">
        <View
          style={styles.statusRow}
          testID="project-command-output-page.status"
          accessibilityLiveRegion="polite"
        >
          <RunGlyph glyph={presentation.glyph} />
          <Text
            style={[styles.status, { color: statusColor }]}
            numberOfLines={2}
          >
            {status}
          </Text>
          {presentation.live && presentation.startedAt ? (
            <RunClock startedAt={presentation.startedAt} />
          ) : null}
        </View>
        {props.command ? (
          <Text
            testID="project-command-output-page.command"
            numberOfLines={2}
            style={[styles.command, { color: theme.colors.text.secondary }]}
          >
            {props.command}
          </Text>
        ) : null}
        <View style={styles.output} onLayout={onOutputLayout}>
          {attachment?.terminalId ? (outputHeight ? (
            <ProjectCommandOutputFrame>
              <ProjectCommandOutputPane
                operation={operation}
                ownerStatesExit
                emptyOutput={emptyOutput}
                title={props.name}
                height={outputHeight}
                presentation="page"
                onOpenDetail={() =>
                  openActionOperationDetail({
                    serverId: props.serverId,
                    operationId: props.operationId,
                  })
                }
              />
            </ProjectCommandOutputFrame>
          ) : null) : emptyOutput}
        </View>
        {canStop ? (
          <View style={styles.footer}>
            <RoundButton
              testID="project-command-output-page.stop"
              title={
                stopping
                  ? t('projects.scripts.run.stopping')
                  : t('projects.scripts.stopScript', { name: props.name })
              }
              loading={stop.pending}
              disabled={stopping}
              onPress={stop.requestStop}
            />
          </View>
        ) : null}
      </View>
    );
  },
);

/** Opens a project command's output page (phone); the operation detail stays one press away inside it. */
export function openProjectCommandOutputPage(
  props: Omit<ProjectCommandOutputPageProps, keyof CustomModalInjectedProps>,
): void {
  Modal.show({
    component: ProjectCommandOutputPage,
    props,
    closeOnBackdrop: true,
    accessibilityLabel: props.name,
  });
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    minHeight: 0,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s16,
    gap: theme.space.s8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
    minHeight: 32,
  },
  status: {
    flex: 1,
    minWidth: 0,
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
  },
  command: {
    ...Typography.mono(),
    ...happierPageTextMetrics('meta'),
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
  output: {
    flex: 1,
    minHeight: 0,
    paddingTop: theme.space.s4,
  },
  empty: {
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
  footer: {
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
}));
