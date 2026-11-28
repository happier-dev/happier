import { deploymentBackupTargetOperands } from '@happier-dev/deployments';
import * as React from 'react';
import { Button, ErrorState, Row, Stack, Text } from '@happier-dev/plugin-ui';
import type { HostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import {
    DeploymentBackupSectionActions,
    deploymentBackupAttention,
    useDeploymentBackupFacts,
    useDeploymentBackupOperations,
} from './DeploymentBackupControls';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import { readDeploymentWorkbenchLifetime, type DeploymentWorkbenchPresentationScope } from './DeploymentWorkbenchAccess';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { useDeploymentProject } from './useDeploymentProject';
import { useDeploymentPresentationDemand } from './useDeploymentPresentationDemand';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

type BackupTarget = Parameters<NonNullable<HostDatabaseWorkbench['renderProductionBackup']>>[0];
type WriteSetup = Parameters<NonNullable<HostDatabaseWorkbench['renderWriteSetup']>>[0];
type Binding = Extract<EnvironmentSecretBindingV1, { purpose: 'dataRole' }>;
type SecretSource = NonNullable<Binding['source']>;
const noMoreActions: readonly never[] = [];
const backupCopy = 'projects.deployments.settingsSections.databaseAccess.backup';
const setupCopy = 'projects.deployments.settingsSections.databaseAccess.setup';

function useReviewEnvironment(target: BackupTarget, scope: DeploymentWorkbenchPresentationScope, onApproved?: () => void) {
    const { serverId, projectSourceId, environmentId } = target.environment;
    const presented = useDeploymentPresentationDemand(true);
    const lifetime = readDeploymentWorkbenchLifetime(scope, serverId);
    const { actions, controller } = useDeploymentProject(lifetime, projectSourceId, presented);
    const record = useDeploymentEnvironmentRecord(controller, environmentId, presented);
    const approval = useActionApprovalContinuation({
        scopeKey: `${serverId}:${lifetime?.scope.accountId}:database-review:${environmentId}`,
        serverId, onExecuted: () => { onApproved?.(); void record.refresh(); },
    });
    const { openApproval, requestApproval } = approval;
    const pendingId = approval.approvalPending ? approval.approvalId : null;
    React.useEffect(() => { if (pendingId) openApproval(); }, [pendingId, openApproval]);
    const review = {
        request: requestApproval,
        pendingId,
        open: openApproval,
    };
    const detail = record.snapshot.value;
    return { actions, detail, lifetime, record, review, presented: presented.visible };
}

/** Finite, optional backup operations owned by the exact running native Environment. */
export function DeploymentWorkbenchProductionBackup({ target, scope }: Readonly<{ target: BackupTarget; scope: DeploymentWorkbenchPresentationScope }>) {
    const unavailable = t(`${backupCopy}.unavailable`);
    const { actions, detail, review, record, presented } = useReviewEnvironment(target, scope);
    const configured = detail?.content.backup;
    const configuration = target.kind === 'deployment_service' && detail?.runtimeTargetLink?.id === target.targetLinkId
        && detail.runtimeTargetLink.activeDeploymentId === target.deploymentId
        && configured && 'configRevision' in configured
        && configured.sources.some(source => source.kind === 'dump' && source.service === target.serviceId)
        ? configured : null;
    const input = configuration && detail ? deploymentBackupTargetOperands(detail, configuration) : null;
    const backup = useDeploymentBackupFacts(actions, input, presented, null, { includeMissedSchedules: false });
    const operations = useDeploymentBackupOperations({
        actions: detail?.environment.capabilities.role === 'manager' ? actions : null,
        configuration, detail: detail ?? null, review, onSettled: backup.reload,
    });
    const { lastGood } = deploymentBackupAttention(backup.facts);
    return <Stack gap="small">
        {detail ? <Text value={detail.content.name} variant="label" /> : null}
        {input && operations.run ? <DeploymentBackupSectionActions operations={operations} onRestore={null}
            more={noMoreActions} testID="database-workbench.production-backup" /> : null}
        {input ? <Text tone="secondary" variant="meta" value={lastGood
            ? `${t(`${backupCopy}.action`)} ${formatAsOfTime(lastGood.completedAt)}`
            : backup.facts?.status === 'loading' ? t('common.loading')
            : backup.facts?.status === 'unavailable' ? unavailable : t(`${backupCopy}.empty`)} /> : null}
        {operations.change.outcome ? <DeployOutcomeBanner controller={operations.change.banner}
            machine={operations.machineId ?? ''} copy="setting" /> : null}
        {operations.result ? <Text tone="secondary" variant="meta" value={operations.result} /> : null}
        {record.snapshot.status === 'unavailable' ? <ErrorState layout="line" kind="unavailable"
            title={unavailable} details={record.snapshot.failure?.code} /> : null}
    </Stack>;
}

/** Credentials stay inside Saved Secrets and the selected Environment's reviewed binding writer. */
export function DeploymentWorkbenchWriteSetup({ target, code, onConfigured, scope }:
    WriteSetup & Readonly<{ scope: DeploymentWorkbenchPresentationScope }>) {
    const [configured, setConfiguredState] = React.useState(false);
    const setConfigured = (value: true) => { setConfiguredState(value); onConfigured(); };
    const bindingReviewed = React.useRef(false);
    const { actions, detail, lifetime, record, review } = useReviewEnvironment(target, scope, () => {
        if (bindingReviewed.current) setConfigured(true);
    });
    const manager = detail?.environment.capabilities.role === 'manager';
    const readOnly = code === 'read_role_setup_required';
    const ownServer = code !== 'write_connection_setup_required';
    const catalog = useSavedSecretCatalog({ scope: manager && ownServer ? lifetime?.scope ?? null : null, includeMaterial: false });
    const [selection, setSelection] = React.useState<SecretSource | null>(null);
    const change = useDeploymentChangePress({ ...review, request(id) {
        bindingReviewed.current = true;
        review.request(id);
    } }, () => { setConfigured(true); void record.refresh(); });
    const operation = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        operation.current = controller;
        return () => { controller.abort(); operation.current = null; };
    }, [lifetime]);
    const managedLinks = !ownServer && target.kind === 'managed_deployment'
        ? detail?.targetLinks.filter(({ targetLink }) => targetLink.role === 'data') : undefined;
    // An Environment-wide variable identifies this target when it has a single data link.
    const existing = managedLinks?.length === 1 && target.kind === 'managed_deployment'
        && managedLinks[0]?.targetLink.id === target.targetLinkId
        ? detail?.content.bindings.find(binding => binding.purpose === 'variable'
            && binding.name === 'DIRECT_URL' && binding.phase === 'runtime' && binding.source.kind === 'secret') : undefined;
    const original = existing?.source.kind === 'secret' ? { kind: 'secret' as const,
        ref: existing.source.ref, resourceRevision: existing.source.resourceRevision } : null;
    const source = selection ?? original;
    const busy = change.running || review.pendingId !== null;
    async function choose() {
        const signal = operation.current?.signal;
        const current = () => signal?.aborted === false && scope.isCurrent() && lifetime?.isCurrent() === true;
        if (!lifetime || !signal || !current()) return;
        const selected = await presentSavedSecretReferencePicker({
            accountLifetime: lifetime, signal, isCurrent: current,
            selected: source ? { ref: source.ref, resourceRevision: source.resourceRevision } : undefined,
        });
        if (selected && current()) setSelection({ kind: 'secret', ref: selected.ref, resourceRevision: selected.resourceRevision });
    }
    async function save() {
        const signal = operation.current?.signal;
        const current = () => signal?.aborted === false && scope.isCurrent() && lifetime?.isCurrent() === true;
        if (!detail || !actions || !manager || !signal || !current()) return;
        const { environment } = detail;
        await change.press(async () => {
            let binding = source;
            if (target.kind === 'deployment_service' && ownServer && !binding) {
                const login = readOnly ? t('plugins.database.readSetup.nativeReader') : t(`${setupCopy}.writer`);
                const ref = await catalog.personalMutations.create({ name: `${detail.content.name} · ${target.serviceId} · ${login}`,
                    value: randomUUID() }, { signal, onApprovalPending: registration => {
                    bindingReviewed.current = false;
                    review.request(registration);
                } });
                if (ref && current()) {
                    binding = { kind: 'secret', ref, resourceRevision: 1 };
                    setSelection(binding);
                }
            }
            if (!current()) return { ok: false, error: 'action_account_scope_changed' };
            if (!binding) return { ok: false, error: 'saved_secret_creation_unconfirmed' };
            const set: Binding = target.kind === 'deployment_service'
                ? { purpose: 'dataRole', service: target.serviceId, role: readOnly ? 'readOnlyPassword' : 'write', source: binding }
                : { purpose: 'dataRole', targetLinkId: target.targetLinkId, role: 'write', source: binding };
            return await actions.setBindings({ environmentId: environment.id, expectedRevision: environment.revision, set: [set], remove: [] });
        });
    }
    if (configured) return readOnly ? null : <Text tone="secondary" value={t(`${setupCopy}.ready`)} />;
    if (!detail) return record.snapshot.status === 'unavailable' ? <ErrorState layout="line" kind="unavailable"
        title={readOnly ? t('plugins.database.readSetup.nativeUnavailable') : t(`${setupCopy}.unavailable`)}
        details={record.snapshot.failure?.code} onRetry={record.refresh} retryLabel={t('common.retry')} />
        : <Text tone="secondary" value={t('common.loading')} />;
    if (!manager) return <Text tone="secondary" value={readOnly
        ? t('plugins.database.readSetup.nativeManager') : t(`${setupCopy}.manager`)} />;
    // The setup is the Review's way forward while it stands: its next step is the filled control.
    const choosing = !ownServer && !source;
    return <Stack gap="small">
        <Text value={readOnly ? t('plugins.database.readSetup.nativeBody')
            : t(`${setupCopy}.${ownServer ? 'ownBody' : source ? 'managedSelected' : 'managedBody'}`)} />
        {!ownServer ? <Row><Button title={source ? t(`${setupCopy}.changeSecret`) : t(`${setupCopy}.chooseSecret`)}
            testID="database-workbench.write-setup.secret" variant={choosing ? 'primary' : 'secondary'} disabled={busy} onPress={choose} /></Row> : null}
        <Row><Button title={readOnly ? t('plugins.database.readSetup.nativeCreate')
            : t(`${setupCopy}.${ownServer ? 'createRole' : 'bindConnection'}`)} variant={choosing ? 'secondary' : 'primary'}
            testID={readOnly ? 'database-workbench.read-setup.save' : 'database-workbench.write-setup.save'}
            disabled={busy || !actions || !lifetime || (ownServer ? !source && !catalog.personalMutationsAvailable : !source)}
            onPress={save} /></Row>
        {review.pendingId && !change.banner.pending ? <Row><Button title={t('approvals.review')} onPress={review.open} /></Row> : null}
        {change.outcome ? <DeployOutcomeBanner controller={change.banner} machine={detail.environment.controllerMachineId} copy="setting" /> : null}
    </Stack>;
}
