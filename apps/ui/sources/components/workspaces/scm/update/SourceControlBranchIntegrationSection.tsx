import * as React from 'react';
import { View } from 'react-native';

import { Modal } from '@/modal';
import { t } from '@/text';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmMutationResponse } from '@/scm/operations/runSessionScmMutation';
import type { ScmOperationState, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
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
    snapshot: ScmWorkingSnapshot | null;
    rootPath: string | null;
    disabled?: boolean;
    writeEnabled?: boolean;
    onMerge: (sourceRef: string) => Promise<ScmMutationResponse>;
    onRebase: (sourceRef: string) => Promise<ScmMutationResponse>;
    onContinue: (operation: ScmOperationState['kind']) => Promise<ScmMutationResponse>;
    onAbort: (operation: ScmOperationState['kind']) => Promise<ScmMutationResponse>;
    onSkip?: (operation: ScmOperationState['kind']) => Promise<ScmMutationResponse>;
}>) {
    const [sourceRef, setSourceRef] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const sourceRefRef = React.useRef(sourceRef);
    const updateSourceRef = React.useCallback((value: string) => {
        sourceRefRef.current = value;
        setSourceRef(value);
    }, []);
    const latestSnapshotRef = React.useRef(props.snapshot);
    latestSnapshotRef.current = props.snapshot;
    const latestRootPathRef = React.useRef(props.rootPath);
    latestRootPathRef.current = props.rootPath;
    const latestWriteEnabledRef = React.useRef(props.writeEnabled);
    latestWriteEnabledRef.current = props.writeEnabled;
    const operationState = props.snapshot?.operationState ?? null;
    const capabilities = props.snapshot?.capabilities;
    const hasSourceRef = sourceRef.trim().length > 0;
    const baseDisabled = props.disabled === true || props.writeEnabled !== true || busy;
    const mergePreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_merge',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.rootPath,
        snapshot: props.snapshot,
        sourceRef,
    }), [props.rootPath, props.snapshot, props.writeEnabled, sourceRef]);
    const rebasePreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_rebase',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.rootPath,
        snapshot: props.snapshot,
        sourceRef,
    }), [props.rootPath, props.snapshot, props.writeEnabled, sourceRef]);
    const continuePreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_operation_continue',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.rootPath,
        snapshot: props.snapshot,
        operation: operationState?.kind ?? null,
    }), [operationState?.kind, props.rootPath, props.snapshot, props.writeEnabled]);
    const abortPreflight = React.useMemo(() => evaluateScmOperationPreflight({
        intent: 'branch_operation_abort',
        scmWriteEnabled: props.writeEnabled === true,
        sessionPath: props.rootPath,
        snapshot: props.snapshot,
        operation: operationState?.kind ?? null,
    }), [operationState?.kind, props.rootPath, props.snapshot, props.writeEnabled]);
    const canMerge = !baseDisabled && capabilities?.writeBranchMerge === true && hasSourceRef && mergePreflight.allowed;
    const canRebase = !baseDisabled && capabilities?.writeBranchRebase === true && hasSourceRef && rebasePreflight.allowed;
    const canControl = !baseDisabled && capabilities?.writeBranchOperationControl === true && operationState != null;
    const canSkip = !baseDisabled && capabilities?.writeBranchOperationSkip === true
        && operationState?.canSkip === true && Boolean(props.onSkip);

    const showFailure = React.useCallback((fallback: string, response: ScmMutationResponse) => {
        // The shared mutation owner reconciles and publishes rich results to the pane's one outcome line.
        // An unstarted operation (for example a held lock) has no log result and still needs feedback here.
        if (response.outcome || response.success) return;
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
                    ? await props.onMerge(trimmedSourceRef)
                    : await props.onRebase(trimmedSourceRef);
                showFailure(
                    kind === 'merge'
                        ? t('files.sourceControlOperations.update.branchIntegration.errors.mergeFailed')
                        : t('files.sourceControlOperations.update.branchIntegration.errors.rebaseFailed'),
                    response,
                );
            } finally {
                setBusy(false);
            }
        })();
    }, [props, showFailure]);

    const runControl = React.useCallback((kind: 'continue' | 'abort' | 'skip') => {
        void (async () => {
            if (!operationState) return;
            if (kind === 'abort') {
                const confirmed = await Modal.confirm(
                    t('files.sourceControlOperations.update.branchIntegration.abort'),
                    t('files.sourceControlOperations.update.branchIntegration.operationInProgress', {
                        operation: operationState.kind,
                        source: operationState.sourceRef ?? t('status.unknown'),
                    }),
                    {
                        confirmText: t('files.sourceControlOperations.update.branchIntegration.abort'),
                        cancelText: t('common.cancel'),
                        destructive: true,
                    },
                );
                if (!confirmed) return;

                const nextSnapshot = latestSnapshotRef.current;
                const nextOperationState = nextSnapshot?.operationState ?? null;
                const nextAbortPreflight = evaluateScmOperationPreflight({
                    intent: 'branch_operation_abort',
                    scmWriteEnabled: latestWriteEnabledRef.current === true,
                    sessionPath: latestRootPathRef.current,
                    snapshot: nextSnapshot,
                    operation: nextOperationState?.kind ?? null,
                });
                if (!nextAbortPreflight.allowed) {
                    Modal.alert(t('common.error'), nextAbortPreflight.message);
                    return;
                }
                if (!nextOperationState) return;
            }
            setBusy(true);
            try {
                const currentOperationState = latestSnapshotRef.current?.operationState ?? operationState;
                if (!currentOperationState) return;
                if (kind === 'skip' && (currentOperationState.canSkip !== true
                    || latestSnapshotRef.current?.capabilities?.writeBranchOperationSkip !== true || !props.onSkip)) return;
                const control = kind === 'continue' ? props.onContinue : kind === 'abort' ? props.onAbort : props.onSkip;
                if (!control) return;
                const response = await control(currentOperationState.kind);
                showFailure(
                    kind !== 'abort'
                        ? t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed')
                        : t('files.sourceControlOperations.update.branchIntegration.errors.abortFailed'),
                    response,
                );
            } finally {
                setBusy(false);
            }
        })();
    }, [operationState, props, showFailure]);

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
                    skipDisabled={!canSkip}
                    onContinue={() => runControl('continue')}
                    onAbort={() => runControl('abort')}
                    onSkip={operationState.canSkip && capabilities?.writeBranchOperationSkip && props.onSkip ? () => runControl('skip') : undefined}
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
    skipDisabled: boolean;
    onContinue: () => void;
    onAbort: () => void;
    onSkip?: () => void;
}>) {
    return (
        <View
            style={{
                borderWidth: 1,
                borderColor: props.theme.colors.border.default,
                borderRadius: 8,
                backgroundColor: props.theme.colors.surface.inset,
                padding: 10,
                gap: 8,
            }}
        >
            <Text style={{ fontSize: 12, color: props.theme.colors.text.primary, ...Typography.default('semiBold') }}>
                {t('files.sourceControlOperations.update.branchIntegration.operationInProgress', {
                    operation: props.operationState.kind,
                    source: props.operationState.sourceRef ?? t('status.unknown'),
                })}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
                {props.onSkip ? (
                    <SourceControlUpdateButton
                        theme={props.theme}
                        testID="scm-update-branch-operation-skip"
                        label={t('sessionGitPane.flow.conflicts.skip')}
                        disabled={props.skipDisabled}
                        onPress={props.onSkip}
                    />
                ) : null}
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
