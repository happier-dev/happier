import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MANAGED_EXEC_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedExecOutputV1Schema, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { ActionOperationDetailControls } from '@/components/inbox/actionOperations/ActionOperationDetailControls';
import { canRequestActionOperationStop, describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { useScopedActionRun } from '@/components/machines/security/useScopedActionRun';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { randomUUID } from '@/platform/randomUUID';
import { useActionOperation, useActionOperationByRequestId } from '@/sync/domains/actionOperations/useActionOperations';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { describeManagedActionFailureDiagnostic } from './managedNativeFailurePresentation';

type SheetProps = Readonly<{
    binding: ServerCredentialAccountScopeBinding;
    homeId: string;
    managedId: string;
    controllerId?: string;
    machineName: string;
    executeAction: FrontDoorActionExecute;
}>;

type CommandState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'running'; requestId: string; observing: boolean }>
    | Readonly<{ kind: 'finished'; output: ManagedMachineActionOutputV1<typeof MANAGED_EXEC_ACTION_ID_V1> }>
    | Readonly<{ kind: 'failed'; code: string; diagnostic?: string; reason?: string; requestId?: string }>;

export function showManagedMachineCommandSheet(props: SheetProps): void {
    Modal.show({ component: ManagedMachineCommandSheet, props, closeOnBackdrop: false });
}

function ManagedMachineCommandSheet(props: SheetProps & CustomModalInjectedProps) {
    const { binding, controllerId, homeId, managedId, machineName, onClose } = props;
    const { serverId, accountId } = binding.scope;
    const { run, abort, inFlight } = useScopedActionRun(serverId);
    const [script, setScript] = React.useState('');
    const [state, setState] = React.useState<CommandState>({ kind: 'idle' });
    const approval = useActionApprovalContinuation({ scopeKey: `${serverId}/${accountId}/${managedId}`, serverId, onExecuted: () => {} });
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;

    React.useEffect(() => {
        if (!binding.isCurrent()) closeRef.current();
        const retirement = binding.onRetire(() => closeRef.current());
        return () => { retirement.dispose(); abort(); };
    }, [abort, binding]);

    const running = state.kind === 'running';
    const requestId = 'requestId' in state ? state.requestId ?? null : null;
    const observing = state.kind === 'running' ? state.observing : requestId !== null;
    const snapshot = useActionOperationByRequestId(requestId, serverId, accountId);
    const operation = useActionOperation(snapshot ? { serverId, operationId: snapshot.operationId } : null,
        controllerId && observing && requestId
            ? { machineId: controllerId, actionId: MANAGED_EXEC_ACTION_ID_V1, lifetime: binding, requestId } : undefined);
    const status = operation ? resolveActionOperationStatus(operation.snapshot, operation.observation) : null;
    const stopOperation = operation && canRequestActionOperationStop(operation.snapshot, operation.observation) ? operation : null;
    const observedOutput = operation?.snapshotComplete && operation.snapshot.state === 'succeeded'
        ? ManagedExecOutputV1Schema.safeParse(operation.snapshot.result) : null;
    const output = state.kind === 'finished' ? state.output : observedOutput?.data;

    const submit = async () => {
        if (!binding.isCurrent() || inFlight() || script.trim().length === 0) return;
        const requestId = randomUUID();
        const input = { homeId, managedId, argv: ['/bin/sh', '-c', script] };
        setState({ kind: 'running', requestId, observing: false });
        const result = await run(MANAGED_EXEC_ACTION_ID_V1, input,
            signal => props.executeAction.confirmed(MANAGED_EXEC_ACTION_ID_V1, input, {
                surface: 'ui', serverId, expectedAccountId: accountId, actionRequestId: requestId, signal,
                onTransportIssued: () => {
                    if (!signal.aborted && binding.isCurrent()) setState({ kind: 'running', requestId, observing: true });
                },
            }),
            approval.requestApproval);
        if (!result || !binding.isCurrent()) return;
        if (!result.ok) {
            setState({ kind: 'failed', code: result.errorCode,
                ...(isActionOutcomeUnknownErrorCodeV1(result.errorCode) ? { requestId } : {}),
                reason: resolveActionExecutionFailureMessage(result, '') || undefined,
                diagnostic: describeManagedActionFailureDiagnostic(result.errorCode, result.details, requestId, result.failureCause) });
            return;
        }
        // The Action validates the transport; this narrows the front door's generic result for the sheet.
        const output = ManagedExecOutputV1Schema.safeParse(result.result);
        setState(output.success ? { kind: 'finished', output: output.data } : { kind: 'failed', code: 'action_invalid_output' });
    };

    const footer = stopOperation ? <ActionOperationDetailControls operation={stopOperation} canCancel terminal={false} onClose={onClose} /> : (
        <ModalCardFooterActions cancel={{ onPress: onClose, title: t('common.close'), testID: 'managed-machine.command.close' }}>
            <RoundButton title={t('common.run')} testID="managed-machine.command.run" loading={running}
                disabled={running || script.trim().length === 0}
                onPress={() => fireAndForget(submit(), { tag: 'ManagedMachineCommandSheet.run' })} />
        </ModalCardFooterActions>
    );
    useModalCardChrome(props.setChrome, {
        kind: 'card', title: t('managedMachines.inspect.runCommand'), subtitle: machineName, footer,
        phonePresentation: 'sheet', scrollHost: 'bounded', dimensions: { size: 'md', maxHeightRatio: 0.88 },
    });

    return (
        <ListPresentationProvider value="page" pageInsets="contained">
            <View testID="managed-machine.command" style={styles.body}>
                <ItemGroup header="none">
                    <Item title={t('common.command')} showChevron={false} accessoryLayout="stacked" rightElement={
                        <FieldTextInput testID="managed-machine.command.input" accessibilityLabel={t('common.command')}
                            autoFocus autoCapitalize="none" editable={!running} monospace multiline
                            value={script} onChangeText={setScript} />
                    } />
                </ItemGroup>
                {!output && state.kind === 'running' ? approval.approvalPending ? (
                    <ActionApprovalPendingNotice testID="managed-machine.command.approval" presentation="banner"
                        message={t('approvals.waitingForYou')} onOpenApproval={approval.openApproval} />
                ) : (
                    <SurfaceStateCard size="line" kind="loading" title={status ? describeActionOperationStatusLabel(status.label)
                        : t('inbox.actionOperations.status.running')} />
                ) : null}
                {!output && state.kind === 'failed' ? (
                    <SurfaceStateCard size="line" kind="warning"
                        title={isActionOutcomeUnknownErrorCodeV1(state.code)
                            ? t('inbox.actionOperations.status.outcomeUncertain') : state.code === 'cancelled'
                                ? t('inbox.actionOperations.status.cancelled') : t('inbox.actionOperations.status.failed')}
                        reason={isActionOutcomeUnknownErrorCodeV1(state.code) || state.code === 'cancelled' ? undefined : state.reason}
                        diagnosticCode={state.diagnostic ?? state.code} />
                ) : null}
                {output ? (
                    <>
                        <Text variant="meta" testID="managed-machine.command.exit">
                            {`${t('tools.structuredResult.exit')} ${output.exitCode ?? t('common.unknown')}`}
                        </Text>
                        <CommandStream stream="stdout" text={output.stdout} truncated={output.stdoutTruncated} />
                        <CommandStream stream="stderr" text={output.stderr} truncated={output.stderrTruncated} />
                    </>
                ) : null}
                {props.setChrome ? null : footer}
            </View>
        </ListPresentationProvider>
    );
}

function CommandStream(props: Readonly<{ stream: 'stdout' | 'stderr'; text: string; truncated: boolean }>) {
    return (
        <ItemGroup title={t(`tools.structuredResult.${props.stream}`)}>
            <SectionContentRow>
                <Text selectable={props.text.length > 0} style={Typography.mono()}>{props.text || t('tools.fullView.noOutput')}</Text>
                {props.truncated ? <Text variant="meta" testID={`managed-machine.command.${props.stream}-truncated`}>
                    {t('managedMachines.inspect.outputTruncated')}
                </Text> : null}
            </SectionContentRow>
        </ItemGroup>
    );
}

const styles = StyleSheet.create(theme => ({
    body: { gap: theme.space.s12, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
}));
