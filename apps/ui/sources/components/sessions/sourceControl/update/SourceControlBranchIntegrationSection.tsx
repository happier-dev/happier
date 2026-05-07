import * as React from 'react';
import { View } from 'react-native';

import { Modal } from '@/modal';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmOperationState, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmBranchMerge,
    sessionScmBranchOperationAbort,
    sessionScmBranchOperationContinue,
    sessionScmBranchRebase,
} from '@/sync/ops/sessions';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
    SourceControlUpdateButton,
    SourceControlUpdateInput,
    SourceControlUpdateSection,
    type SourceControlUpdateTheme,
} from './SourceControlUpdateControls';

export function SourceControlBranchIntegrationSection(props: Readonly<{
    theme: SourceControlUpdateTheme;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    writeEnabled?: boolean;
}>) {
    const [sourceRef, setSourceRef] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const sourceRefRef = React.useRef(sourceRef);
    const updateSourceRef = React.useCallback((value: string) => {
        sourceRefRef.current = value;
        setSourceRef(value);
    }, []);
    const operationState = props.snapshot?.operationState ?? null;
    const capabilities = props.snapshot?.capabilities;
    const hasSourceRef = sourceRef.trim().length > 0;
    const baseDisabled = props.disabled === true || props.writeEnabled !== true || busy;
    const mergePreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_merge',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.snapshot?.repo.rootPath ?? null,
        snapshot: props.snapshot,
        sourceRef,
    }), [props.snapshot, props.writeEnabled, sourceRef]);
    const rebasePreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_rebase',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.snapshot?.repo.rootPath ?? null,
        snapshot: props.snapshot,
        sourceRef,
    }), [props.snapshot, props.writeEnabled, sourceRef]);
    const continuePreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_operation_continue',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.snapshot?.repo.rootPath ?? null,
        snapshot: props.snapshot,
        operation: operationState?.kind ?? null,
    }), [operationState?.kind, props.snapshot, props.writeEnabled]);
    const abortPreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_operation_abort',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.snapshot?.repo.rootPath ?? null,
        snapshot: props.snapshot,
        operation: operationState?.kind ?? null,
    }), [operationState?.kind, props.snapshot, props.writeEnabled]);
    const canMerge = !baseDisabled && capabilities?.writeBranchMerge === true && hasSourceRef && mergePreflight.allowed;
    const canRebase = !baseDisabled && capabilities?.writeBranchRebase === true && hasSourceRef && rebasePreflight.allowed;
    const canControl = !baseDisabled && capabilities?.writeBranchOperationControl === true && operationState != null;

    const refresh = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [props.sessionId]);

    const showFailure = React.useCallback((fallback: string, response: { success: boolean; error?: string }) => {
        if (response.success) return;
        Modal.alert(t('common.error'), response.error || fallback);
    }, []);

    const runStart = React.useCallback((kind: 'merge' | 'rebase') => {
        void (async () => {
            const trimmedSourceRef = sourceRefRef.current.trim();
            if (!trimmedSourceRef) {
                Modal.alert(t('common.error'), t('files.sourceControlOperations.update.branchIntegration.errors.sourceRequired'));
                return;
            }
            setBusy(true);
            try {
                const response = kind === 'merge'
                    ? await sessionScmBranchMerge(props.sessionId, { sourceRef: trimmedSourceRef })
                    : await sessionScmBranchRebase(props.sessionId, { sourceRef: trimmedSourceRef });
                if (!response.success) {
                    showFailure(
                        kind === 'merge'
                            ? t('files.sourceControlOperations.update.branchIntegration.errors.mergeFailed')
                            : t('files.sourceControlOperations.update.branchIntegration.errors.rebaseFailed'),
                        response,
                    );
                    return;
                }
                await refresh();
            } finally {
                setBusy(false);
            }
        })();
    }, [props.sessionId, refresh, showFailure]);

    const runControl = React.useCallback((kind: 'continue' | 'abort') => {
        void (async () => {
            if (!operationState) return;
            setBusy(true);
            try {
                const response = kind === 'continue'
                    ? await sessionScmBranchOperationContinue(props.sessionId, { operation: operationState.kind })
                    : await sessionScmBranchOperationAbort(props.sessionId, { operation: operationState.kind });
                if (!response.success) {
                    showFailure(
                        kind === 'continue'
                            ? t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed')
                            : t('files.sourceControlOperations.update.branchIntegration.errors.abortFailed'),
                        response,
                    );
                    return;
                }
                await refresh();
            } finally {
                setBusy(false);
            }
        })();
    }, [operationState, props.sessionId, refresh, showFailure]);

    return (
        <SourceControlUpdateSection
            theme={props.theme}
            title={t('files.sourceControlOperations.update.branchIntegration.title')}
            testID="scm-update-branch-integration-section"
        >
            {operationState ? (
                <BranchOperationBanner
                    theme={props.theme}
                    operationState={operationState}
                    continueDisabled={!canControl || !continuePreflight.allowed}
                    abortDisabled={!canControl || !abortPreflight.allowed}
                    onContinue={() => runControl('continue')}
                    onAbort={() => runControl('abort')}
                />
            ) : null}
            <SourceControlUpdateInput
                theme={props.theme}
                testID="scm-update-branch-source-picker"
                accessibilityLabel={t('files.sourceControlOperations.update.branchIntegration.sourceLabel')}
                placeholder={t('files.sourceControlOperations.update.branchIntegration.sourcePlaceholder')}
                value={sourceRef}
                editable={!baseDisabled}
                onChangeText={updateSourceRef}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
                <SourceControlUpdateButton
                    theme={props.theme}
                    testID="scm-update-branch-merge"
                    label={t('files.sourceControlOperations.update.branchIntegration.merge')}
                    disabled={!canMerge}
                    onPress={() => runStart('merge')}
                />
                <SourceControlUpdateButton
                    theme={props.theme}
                    testID="scm-update-branch-rebase"
                    label={t('files.sourceControlOperations.update.branchIntegration.rebase')}
                    disabled={!canRebase}
                    onPress={() => runStart('rebase')}
                />
            </View>
        </SourceControlUpdateSection>
    );
}

function BranchOperationBanner(props: Readonly<{
    theme: SourceControlUpdateTheme;
    operationState: ScmOperationState;
    continueDisabled: boolean;
    abortDisabled: boolean;
    onContinue: () => void;
    onAbort: () => void;
}>) {
    return (
        <View
            style={{
                borderWidth: 1,
                borderColor: props.theme.colors.divider,
                borderRadius: 8,
                backgroundColor: props.theme.colors.surfaceHigh,
                padding: 10,
                gap: 8,
            }}
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text, ...Typography.default('semiBold') }}>
                {t('files.sourceControlOperations.update.branchIntegration.operationInProgress', {
                    operation: props.operationState.kind,
                    source: props.operationState.sourceRef ?? t('status.unknown'),
                })}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
                {props.operationState.canContinue ? (
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-update-branch-operation-continue"
                        label={t('files.sourceControlOperations.update.branchIntegration.continue')}
                        disabled={props.continueDisabled}
                        onPress={props.onContinue}
                    />
                ) : null}
                {props.operationState.canAbort ? (
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-update-branch-operation-abort"
                        label={t('files.sourceControlOperations.update.branchIntegration.abort')}
                        kind="danger"
                        disabled={props.abortDisabled}
                        onPress={props.onAbort}
                    />
                ) : null}
            </View>
        </View>
    );
}
