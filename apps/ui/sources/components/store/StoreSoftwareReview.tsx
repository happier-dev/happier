import * as React from 'react';
import { StoreBrowserExtensionReview, type StoreBrowserExtensionReviewProps } from './StoreBrowserExtensionReview';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import type { MachineSetupPreparedApply, MachineSetupPreparedRemove } from '@/components/settings/machines/managed/machineSetupReview';
import { describeMachineSetupPlanFailure, MachineSetupPlanReview, MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import type { StoreSoftwareEntryState } from './StoreSoftwareEntry';
import { SoftwareMachineSelect, useSoftwareMachines, type SoftwareMachines } from './StoreSoftwareTargets';
import type { InstalledSoftwareRow } from './catalog/storeSoftwareInstalled';
import { prepareMachineSetupSoftwareRemoveInput, removeMachineSetupSoftware } from '@/components/settings/machines/managed/machineSetupSoftware';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { prepareMachineSetupPresetApplyInput, type MachineSetupPresetInput } from '@/components/settings/machines/managed/machineSetupApply';

const execute = createFrontDoorActionExecute();

type Prepared = Extract<MachineSetupPreparedApply | MachineSetupPreparedRemove, { ok: true }>;
type InstallReviewProps = Readonly<{
  intent?: 'install';
  name: string;
  prepared: Extract<MachineSetupPreparedApply, { ok: true }>;
  machines: SoftwareMachines;
  apply: StoreSoftwareEntryState['apply'];
  /** Plans the same install again with another Machine running it. */
  prepareOn?: (selectedMachineId: string) => Promise<MachineSetupPreparedApply>;
  scope: ServerAccountScope;
}>;
type RemoveReviewProps = Readonly<{
  intent: 'remove';
  name: string;
  row: Extract<InstalledSoftwareRow, { subject: 'recipe' }>;
  scope: ServerAccountScope;
}>;
type PresetReviewProps = Readonly<{
  intent: 'preset';
  name: string;
  preset: MachineSetupPresetInput;
  scope: ServerAccountScope;
}>;
type ReviewProps = InstallReviewProps | RemoveReviewProps | PresetReviewProps;

/** The one review for every chosen Machine (lab `w:review`); its Install is the one apply, which asks first. */
export function showStoreSoftwareReview(props: ReviewProps) {
  Modal.show({ component: StoreSoftwareReview, props });
}

/** The Installed row uses the same review, with one exact installation chosen before native preparation. */
export function showStoreSoftwareRemovalReview(props: Omit<RemoveReviewProps, 'intent' | 'scope'>) {
  Modal.show({ component: StoreSoftwareReview, props: { ...props, intent: 'remove', scope: props.row.scope } });
}

/** Bundled presets choose an enrolled Machine in the existing review before Plan. */
export function showStoreSoftwarePresetReview(props: Omit<PresetReviewProps, 'intent'>) {
  Modal.show({ component: StoreSoftwareReview, props: { ...props, intent: 'preset' } });
}

function StoreSoftwareReview(props: ReviewProps & CustomModalInjectedProps) {
  const router = useRouter();
  const { onClose } = props;
  const { serverId, accountId } = props.scope;
  const apply = 'apply' in props ? props.apply : undefined;
  const prepareOn = 'prepareOn' in props ? props.prepareOn : undefined;
  // Changing where it runs re-plans the same install; the review shows the latest plan.
  const [prepared, setPrepared] = React.useState<Prepared | null>('prepared' in props ? props.prepared : null);
  const allMachines = useSoftwareMachines();
  const machines = 'machines' in props ? props.machines : allMachines;
  const row = props.intent === 'remove' ? props.row : null;
  const preset = props.intent === 'preset' ? props.preset : null;
  const installedMachines = React.useMemo(() => ({ targets: machines.targets.filter(entry =>
    row?.installations.some(installation => installation.machineId === entry.machine.machineId)) }), [machines.targets, row]);
  const [selectedId, setSelectedId] = React.useState<string | null>(row?.installations.length === 1 ? row.installations[0]!.machineId : null);
  const { binding } = useServerCredentialAccountScopeBinding(props.scope.serverId);
  const preparation = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { preparation.current?.abort(); }, [props.scope.serverId, props.scope.accountId]);
  const [replanning, setReplanning] = React.useState(false);
  const targets = !prepared ? [] : 'targets' in prepared.input ? prepared.input.targets : [prepared.input];
  const nameOf = React.useCallback(
    (machineId: string) => {
      const machine = machines.targets.find(
        (entry) => entry.machine.machineId === machineId,
      )?.machine;
      return machine?.name ?? t('storeInstalled.machineFallback');
    },
    [machines.targets],
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([
      props.scope.serverId,
      props.scope.accountId,
      selectedId ?? prepared?.input.machineId,
    ]),
    serverId: props.scope.serverId,
    onExecuted: () => {},
  });
  const { requestApproval } = approval;
  const opened = React.useCallback(
    (result: unknown) => {
      const output =
        ManagedMachineActionOutputSchemasV1[props.intent === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply'].safeParse(
          result,
        );
      if (!output.success) {
        setError('managed_response_invalid');
        setPending(false);
        return;
      }
      onClose();
      openActionOperationDetail({
        serverId: props.scope.serverId,
        operationId: output.data.operationId,
      });
    },
    [onClose, props.scope.serverId, props.intent],
  );
  const install = React.useCallback(async () => {
    if (pending || !prepared) return;
    setPending(true);
    setError(null);
    const input = prepared.input;
    const actionId = props.intent === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply';
    let result;
    try {
      if (props.intent === 'remove' && !('targets' in prepared.input)) {
        result = await removeMachineSetupSoftware({ executeAction: execute, prepared: { ...prepared, input: prepared.input },
          context: { surface: 'ui', serverId: props.scope.serverId, expectedAccountId: props.scope.accountId } });
      } else if (props.intent === 'preset' && 'targets' in prepared.input) {
        result = await execute.confirmed('machines.setup.apply', prepared.input, {
          surface: 'ui', serverId: props.scope.serverId, expectedAccountId: props.scope.accountId,
        });
      } else if (apply && 'targets' in prepared.input) result = await apply(prepared.input);
      else return;
    } catch {
      setError('managed_request_failed');
      setPending(false);
      return;
    }
    const outcome = classifyHomeActionOutcome(result);
    if (outcome.kind === 'failed') {
      setError(homeDomainFailureCode(outcome.failure));
      setPending(false);
      return;
    }
    if (outcome.kind === 'approval_pending') {
      requestApproval(
        createActionApprovalContinuation({
          artifactId: outcome.artifactId,
          actionId,
          scope: { serverId, accountId },
          expectedInput: input,
          onSucceeded: opened,
          onFailed: (code) => {
            setError(code);
            setPending(false);
          },
        }),
      );
      return;
    }
    opened(outcome.result);
  }, [accountId, apply, opened, pending, prepared, props.intent, requestApproval, serverId]);
  const changeHost = React.useCallback(async (machineId: string) => {
    if (!prepareOn || replanning) return;
    setReplanning(true);
    setError(null);
    const next = await prepareOn(machineId);
    setReplanning(false);
    if (next.ok) setPrepared(next);
    else setError(describeMachineSetupPlanFailure(next, nameOf));
  }, [prepareOn, replanning, nameOf]);
  const reviewSelection = async (machineId: string, removeItemKeys?: string[]) => {
    if ((!row && !preset) || !binding?.isCurrent() || binding.accountId !== props.scope.accountId) return;
    const homeId = getServerProfileById(props.scope.serverId)?.serverIdentityId;
    if (!homeId) return;
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    setReplanning(true);
    setError(null);
    try {
      const request = { executeAction: execute,
        context: { surface: 'ui' as const, serverId: props.scope.serverId, expectedAccountId: props.scope.accountId, signal: controller.signal },
        homeId, machineId, ...(removeItemKeys === undefined ? {} : { removeItemKeys }),
        isCurrent: () => binding.isCurrent() && !controller.signal.aborted };
      const next = preset ? await prepareMachineSetupPresetApplyInput({ ...request, preset })
        : await prepareMachineSetupSoftwareRemoveInput({ ...request, setup: { items: [{ kind: 'softwareRecipe', selection: row!.native }] } });
      if (controller.signal.aborted || !binding.isCurrent()) return;
      if (next === null) { setSelectedId(null); return; }
      if (next.ok) setPrepared(next);
      else setError(describeMachineSetupPlanFailure(next, nameOf));
    } catch {
      if (!controller.signal.aborted && binding.isCurrent()) setError('managed_request_failed');
    } finally {
      if (preparation.current === controller) { preparation.current = null; setReplanning(false); }
    }
  };
  React.useEffect(() => {
    if ((row || preset) && selectedId) void reviewSelection(selectedId);
  }, [row, preset, selectedId, binding]);
  const waiting =
    approval.approvalId !== null && approval.approvalId !== undefined;
  const label = props.intent === 'remove' ? t('common.remove') : props.intent === 'preset' ? t('common.use') :
    targets.length === 1
      ? t('capabilities.store.softwarePage.installOnOne', {
          machine: nameOf(targets[0]!.machineId),
        })
      : t('capabilities.store.softwarePage.installOnMany', {
          count: targets.length,
        });
  const footer = React.useMemo(
    () => (
      <MachineSetupReviewFooter
        prepared={prepared}
        nameOf={nameOf}
        onCancel={onClose}
        cancelTestID="store.software.review.cancel"
        {...(waiting || !prepared ? {} : { primary: { label, testID: props.intent === 'remove' ? 'store.software.review.remove' : 'store.software.review.install', loading: pending,
          disabled: pending || replanning, onPress: () => { void install(); } } })}
      />
    ),
    [install, label, nameOf, onClose, pending, prepared, props.intent, replanning, waiting],
  );
  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: props.intent === 'preset' ? props.name : t(props.intent === 'remove' ? 'capabilities.store.softwarePage.removeTitle' : 'capabilities.store.softwarePage.reviewTitle', {
        name: props.name,
      }),
      subtitle: t(props.intent === 'preset' ? 'machinePresets.setup.tab.reviewHelp' : props.intent === 'remove' ? 'capabilities.store.softwarePage.removeDescription' : 'capabilities.store.softwarePage.reviewDescription'),
      footer,
      phonePresentation: 'sheet' as const,
      dimensions: { size: 'md' as const, maxHeightRatio: 0.84 },
    }),
    [footer, props.name, props.intent],
  );
  useModalCardChrome(props.setChrome, chrome);
  return (
    <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
      {waiting ? (
        <AttentionBanner
          testID="store.software.review.waiting"
          tone="neutral"
          title={t('capabilities.store.softwarePage.waitingTitle')}
          description={t('capabilities.store.softwarePage.waitingBody')}
          action={{
            label: t('capabilities.store.softwarePage.openApproval'),
            onPress: () => {
              onClose();
              router.push(
                `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.scope.serverId)}` as never,
              );
            },
          }}
        />
      ) : null}
      {!prepared && (preset || (row && row.installations.length > 1)) ? (
        <SectionContentRow>
          <SoftwareMachineSelect testID="store.software.review.machine" machines={preset ? machines : installedMachines} selectedId={selectedId}
            placeholder={t('capabilities.store.softwarePage.chooseMachine')}
            onSelect={entry => { preparation.current?.abort(); setPrepared(null); setSelectedId(entry.machine.machineId); }} />
        </SectionContentRow>
      ) : null}
      {!prepared && replanning ? <SurfaceStateCard testID="store.software.review.loading" kind="loading" size="line" title={t('common.loading')} /> : null}
      {prepared ? <MachineSetupPlanReview
        testID="store.software.review"
        prepared={prepared}
        nameOf={nameOf}
        disabled={pending || waiting || replanning}
        {...('prepareOn' in props && props.prepareOn ? { onChangeHost: (machineId: string) => { void changeHost(machineId); } } : {})}
        {...(row || preset ? { onChangeRemoval: (machineId: string, keys: string[]) => { void reviewSelection(machineId, keys); } } : {})}
      /> : null}
      {error ? (
        <SurfaceStateCard
          testID="store.software.review.error"
          kind="error"
          size="line"
          title={t(props.intent === 'remove' ? 'capabilities.store.softwarePage.removeFailed' : 'capabilities.store.softwarePage.applyFailed')}
          diagnosticCode={error}
        />
      ) : null}
    </ItemList>
  );
}

/** Closing, leaving the Account or removing the modal host settles the same declined consent. */
export function showStoreBrowserExtensionReview(props: Omit<StoreBrowserExtensionReviewProps, 'onDecision'> & Readonly<{
    signal: AbortSignal;
}>): Promise<boolean> {
    if (props.signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        let modalId: string | undefined;
        const settle = (accepted: boolean) => {
            props.signal.removeEventListener('abort', abort);
            resolve(accepted);
        };
        const abort = () => {
            settle(false);
            if (modalId) Modal.hide(modalId);
        };
        props.signal.addEventListener('abort', abort, { once: true });
        modalId = Modal.show({ component: StoreBrowserExtensionReview,
            props: { review: props.review, restartRequired: props.restartRequired, confirmText: props.confirmText, onDecision: settle },
            onRequestClose: () => settle(false), onHostUnmount: () => settle(false),
        });
        if (props.signal.aborted) abort();
    });
}
