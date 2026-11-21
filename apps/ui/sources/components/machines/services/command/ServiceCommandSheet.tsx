import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildLogIndexV1 } from '@happier-dev/forge-ci/runtime';
import type { WorkflowMachineCommandOutputV1 } from '@happier-dev/protocol/workflows/commandOutputV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { NativeLogLines, isNativeLogBlank } from '@/components/machines/services/MachineServiceLogs';
import { MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  parseServiceCommand,
  useServiceCommand,
  type ServiceCommandState,
  type ServiceCommandTarget,
} from './useServiceCommand';

export type ServiceCommandSheetProps = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  /** The service as people know it ("web"). */
  serviceName: string;
  /** Who keeps it ("shop · Production"); null for a service no Environment deploys. */
  place: string | null;
  target: ServiceCommandTarget;
  /**
   * A project-level watch's own Compose members when it has several (the set the exec owner validates against):
   * the person picks where the command runs. Absent or empty when the target is already one container.
   */
  services?: readonly string[];
  /** The Action front door; tests build one over the real executor with only the Machine RPC substituted. */
  execute?: FrontDoorActionExecute;
}>;

/**
 * Run a command (lab `machine/services/exec`, phone `execp`; P30 §463): the one composition for
 * `machines.services.exec`, opened from a Machine service page's ⋯ and from an Environment service row's ⋯.
 * One field and where it runs, then the bounded, redacted output in the shared log band with its exit code.
 * The person's press is the approval; the footer says agents ask first.
 */
export function showServiceCommandSheet(props: ServiceCommandSheetProps): void {
  Modal.show({ component: ServiceCommandModal, props, closeOnBackdrop: false });
}

function ServiceCommandModal(
  props: ServiceCommandSheetProps & CustomModalInjectedProps,
) {
  return <ServiceCommandSheet {...props} />;
}

export function ServiceCommandSheet(
  props: ServiceCommandSheetProps & Partial<CustomModalInjectedProps>,
) {
  const services = props.services ?? NO_SERVICES;
  const [chosen, setChosen] = React.useState<string | null>(null);
  // The first member leads until the person picks; a member that left the watch falls back to it.
  const member = services.length === 0 ? null : chosen !== null && services.includes(chosen) ? chosen : services[0]!;
  const target = React.useMemo((): ServiceCommandTarget => member === null ? props.target : { ...props.target, service: member },
    [member, props.target]);
  const where = member ?? props.serviceName;
  const { state, run } = useServiceCommand({
    serverId: props.serverId,
    machineId: props.machineId,
    target,
    ...(props.execute ? { execute: props.execute } : {}),
  });
  const [text, setText] = React.useState('');
  const argv = React.useMemo(() => parseServiceCommand(text), [text]);
  const shellSyntax = text.trim() !== '' && argv === null;
  const running = state.kind === 'running';
  const ran = state.kind !== 'idle';
  const onClose = props.onClose;
  const press = React.useCallback(() => {
    if (argv) void run(argv);
  }, [argv, run]);

  const footer = (
    <MachineSetupReviewFooter
      onCancel={() => onClose?.()}
      cancelLabel={ran ? t('common.close') : undefined}
      cancelTestID="service-command.close"
      note={t('machineServices.command.note')}
      primary={
        state.kind === 'running' && state.approval
          ? undefined
          : {
              label: t(
                ran
                  ? 'machineServices.command.runAgain'
                  : 'machineServices.command.run',
              ),
              testID: 'service-command.run',
              loading: running,
              disabled: running || argv === null,
onPress: press,
            }
      }
    />
  );
  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: t('machineServices.command.title', { service: props.serviceName }),
      subtitle: props.place
        ? t('machineServices.command.subtitlePlace', {
            place: props.place,
            machine: props.machineName,
          })
        : t('machineServices.command.subtitle', { machine: props.machineName }),
      footer,
      phonePresentation: 'sheet' as const,
      // Sized to its content up to the cap (PAGE-ACCEPT-85 D12): empty, it is the field and its note; output scrolls inside.
      scrollHost: 'bounded' as const,
      dimensions: { size: 'md' as const, maxHeightRatio: 0.88 },
      // The footer is rebuilt from the same state each render; the chrome follows it.
    }),
    [footer, props.machineName, props.place, props.serviceName],
  );
  useModalCardChrome(props.setChrome, chrome);

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="service-command" style={styles.body}>
      <ItemGroup header="none">
        <Item
          title={t('machineServices.command.commandTitle')}
          showChevron={false}
          accessoryLayout="stacked"
          rightElement={
            <FieldTextInput
              testID="service-command.input"
              value={text}
              onChangeText={setText}
              accessibilityLabel={t('machineServices.command.commandTitle')}
              placeholder={t('machineServices.command.placeholder')}
              monospace
              autoCapitalize="none"
              autoFocus
              editable={!running}
              returnKeyType="go"
              onSubmitEditing={press}
              error={
                shellSyntax ? t('machineServices.command.shellSyntax') : null
              }
            />
          }
        />
        {member === null ? (
          <Item
            testID="service-command.where"
            title={t('machineServices.command.whereTitle')}
            subtitle={t('machineServices.command.whereRunning', { service: where })}
            subtitleLines={0}
            showChevron={false}
          />
        ) : (
          <ServiceMemberChoice services={services} value={member} disabled={running} onChange={setChosen} />
        )}
      </ItemGroup>
      <ServiceCommandResult
        state={state}
        serverId={props.serverId}
        serviceName={where}
        machineName={props.machineName}
        onClose={() => onClose?.()}
      />
      {/* Rendered outside a modal (a test, a pushed page) the footer stays in the body. */}
      {props.setChrome ? null : footer}
    </View>
    </ListPresentationProvider>
  );
}

/** Where it runs, for a watch with several members: segmented for 2–4, the field select beyond (control table). */
function ServiceMemberChoice(
  props: Readonly<{ services: readonly string[]; value: string; disabled: boolean; onChange: (next: string) => void }>,
) {
  const [open, setOpen] = React.useState(false);
  const title = t('machineServices.command.whereTitle');
  const subtitle = t('machineServices.command.whereRunning', { service: props.value });
  const options = React.useMemo(() => props.services.map(service => ({ id: service, label: service })), [props.services]);
  if (options.length <= 4) {
    return (
      <SegmentedChoiceItem
        testID="service-command.where"
        testIDPrefix="service-command.service"
        title={title}
        subtitle={subtitle}
        options={options}
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return (
    <DropdownMenu
      testID="service-command.where"
      open={open}
      onOpenChange={setOpen}
      items={options.map(option => ({ id: option.id, testID: `service-command.service:${option.id}`, title: option.label }))}
      selectedId={props.value}
      onSelect={(id) => { setOpen(false); props.onChange(id); }}
      itemTrigger={{ title, subtitle, showSelectedSubtitle: false, itemProps: { disabled: props.disabled } }}
    />
  );
}

/** The run's outcome. While the next run goes, the last output stays and the status says Running. */
function ServiceCommandResult(
  props: Readonly<{
    state: ServiceCommandState;
    serverId: string;
    serviceName: string;
    machineName: string;
    onClose: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { state } = props;
  if (state.kind === 'idle') return null;
  if (state.kind === 'running' && state.approval) {
    // The press is the approval, so this appears only when the Machine's own policy still asks (lab `services/exec`).
    const artifactId = state.approval.artifactId;
    return (
      <ActionApprovalPendingNotice
        testID="service-command.approval"
        presentation="banner"
        message={t('machineServices.command.approval')}
        onOpenApproval={() => {
          props.onClose();
          const result = runGuardedNavigation(() => router.push(buildApprovalHref(artifactId, props.serverId) as never));
          if (result !== true) fireAndForget(result, { tag: 'ServiceCommand.approval' });
        }}
      />
    );
  }
  if (state.kind === 'unknown') {
    return (
      <SurfaceStateCard
        testID="service-command.unknown"
        kind="warning"
        size="line"
        title={t('machineServices.command.unknownTitle')}
        reason={t('machineServices.command.unknownBody', { service: props.serviceName })}
      />
    );
  }
  if (state.kind === 'failed') {
    const failure = presentActionExecutionFailure(state.failure ?? { ok: false, errorCode: state.code },
      t('machineServices.command.reason.other', { service: props.serviceName }),
      { closedCodesOnly: true, serviceCommand: { service: props.serviceName, machine: props.machineName } });
    return (
      <SurfaceStateCard
        testID="service-command.failed"
        kind="error"
        size="line"
        diagnosticCode={state.code}
        title={t('machineServices.command.failedTitle', { service: props.serviceName })}
        reason={failure.reason}
        diagnosticDetail={failure.technicalDetails.filter(detail => detail.key !== 'code')
          .map(detail => `${detail.label}: ${detail.value}`).join('\n')}
      />
    );
  }
  const finished = state.kind === 'finished' ? state : state.previous;
  const failedExit = state.kind === 'finished' && state.output.exitCode !== 0;
  const tone = failedExit ? theme.colors.state.warning.foreground : theme.colors.text.secondary;
  return (
    <ItemGroup
      testID="service-command.output"
      title={t('machineServices.command.outputTitle')}
      surface="none"
      action={
        <View style={styles.meta}>
          {state.kind === 'finished' ? (
            <Icon name={failedExit ? 'warning-circle' : 'check-circle'} size={ICON_SIZE.xs} color={tone} />
          ) : null}
          <Text variant="meta" testID="service-command.status" style={{ color: failedExit ? theme.colors.state.warning.textForeground : theme.colors.text.secondary }}>
            {state.kind === 'finished'
              ? t('machineServices.command.finished', {
                  seconds: (state.durationMs / 1000).toFixed(1),
                  code: String(state.output.exitCode),
                })
              : t('machineServices.command.running')}
          </Text>
        </View>
      }
    >
      {finished ? (
        <CommandOutput output={finished.output} />
      ) : (
        <SurfaceStateCard
          testID="service-command.waiting"
          kind="loading"
          size="line"
          title={t('machineServices.command.waiting', { service: props.serviceName })}
        />
      )}
    </ItemGroup>
  );
}

function CommandOutput(
  props: Readonly<{ output: WorkflowMachineCommandOutputV1 }>,
) {
  const { theme } = useUnistyles();
  const { output } = props;
  const lines = React.useMemo(() => {
    const text = [output.stdout, output.stderr]
      .filter((part) => part.length > 0)
      .join(output.stdout.endsWith('\n') ? '' : '\n');
    if (text.length === 0) return [];
    return buildLogIndexV1({
      sourceKey: 'service-command',
      positionBasis: 'page',
      log: {
        logId: 'service-command',
        startLine: 1,
        startByte: 0,
        complete: true,
        continuation: null,
        text,
      },
    }).lines;
  }, [output]);
  const truncated =
    output.stdoutTruncated === true || output.stderrTruncated === true;
  return (
    <View style={styles.output}>
      <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
        {t(
          truncated
            ? 'machineServices.command.redactedTruncated'
            : 'machineServices.command.redacted',
        )}
      </Text>
      {isNativeLogBlank(lines) ? (
        <SurfaceStateCard
          testID="service-command.empty"
          kind="empty"
          size="line"
          title={t('machineServices.command.noOutput')}
        />
      ) : (
        <NativeLogLines
          testID="service-command.lines"
          lines={lines}
          getLineRanges={noRanges}
          revealedLine={null}
        />
      )}
    </View>
  );
}

const NO_RANGES: readonly never[] = [];
const NO_SERVICES: readonly string[] = Object.freeze([]);
const noRanges = () => NO_RANGES;

const styles = StyleSheet.create((theme) => ({
  // Card chrome pads only its header and footer, so the body insets its own sheet to the title's edge (lab `services/exec`).
  body: {
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  output: {
    gap: theme.space.s8,
  },
}));
