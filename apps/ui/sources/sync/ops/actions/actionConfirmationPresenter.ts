import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { createAccountRoleActionExecutorV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { presentActionApproval, readActionApprovalSubject, readActionApprovalRoleId } from '@/components/approvals/actionApprovalPresentation';
import { readApprovalReferenceForConfirmation } from '@/components/approvals/approvalReferenceReading';
import { readDetectedProviderConfirmation } from '@/components/approvals/providerConnectionApprovalPresentation';
import { buildRoleCatalog } from '@/sync/domains/roles/roleCatalog';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { t } from '@/text';
import type { LazyActionAccountContext } from './actionAccountContext';

type ConfirmationPresenter = NonNullable<ActionExecutorDeps['presentUserActionConfirmation']>;

/** One native presenter for finite Actions and their host Resource admissions. Policy stays with the receiving executor. */
export function createActionConfirmationPresenter(accountContext: LazyActionAccountContext, opts?: Readonly<{
  presentUserActionConfirmation?: ConfirmationPresenter;
  accountRoleAction?: ReturnType<typeof createAccountRoleActionExecutorV1> | null;
}>): ConfirmationPresenter {
  const accountRoleAction = opts?.accountRoleAction;
  return async ({ actionId, input, context, preview }) => {
    accountContext.assertCurrent();
    throwIfAborted(context.signal);
    if (opts?.presentUserActionConfirmation) {
      const confirmed = await opts.presentUserActionConfirmation({ actionId, input, context, ...(preview === undefined ? {} : { preview }) });
      if (context.signal?.aborted) return false;
      accountContext.assertCurrent();
      return confirmed;
    }
    const { Modal } = await import('@/modal');
    const presentationInput = { actionId, actionArgs: input, ...(preview === undefined ? {} : { preview }) };
    const detectedProvider = readDetectedProviderConfirmation(actionId, input, accountContext);
    const reference = readActionApprovalSubject(presentationInput)
      ?? (actionId === 'scm.diffSummary.result.clear' && context.externalActionTarget?.kind === 'machine'
        ? { kind: 'machine' as const, id: context.externalActionTarget.machineId } : undefined);
    const reading = await readApprovalReferenceForConfirmation(reference, accountContext, context.signal);
    const roleId = readActionApprovalRoleId(presentationInput);
    const roleResult = roleId && accountRoleAction ? await accountRoleAction({ actionId: 'roles.get', input: { roleId }, context }) : null;
    const roleEntry = roleResult ? RoleActionOutputSchemasV1['roles.get'].safeParse(roleResult) : null;
    const role = roleEntry?.success ? buildRoleCatalog({ items: [roleEntry.data], overrides: {} })[0] : null;
    throwIfAborted(context.signal);
    accountContext.assertCurrent();
    // A Machine-targeted Action names its paths the way that Machine's home reads them (`~/work/app`).
    const targetMachineId = input && typeof input === 'object' && typeof (input as { machineId?: unknown }).machineId === 'string'
      ? (input as { machineId: string }).machineId : null;
    const homeDir = targetMachineId
      ? resolveServerScopedMachine(storage.getState(), accountContext.serverId, targetMachineId)?.metadata?.homeDir?.trim() || null : null;
    const formatPath = homeDir ? (path: string) => formatPathRelativeToHome(path, homeDir) : null;
    const presentation = presentActionApproval({ ...presentationInput, kind: 'confirmation', subject: detectedProvider?.name ?? (reading.named ? reading.text : null), role, formatPath });
    const confirmationSummary = [presentation.summary,
      ...(detectedProvider ? [detectedProvider.where, detectedProvider.availability,
        detectedProvider.models?.title, detectedProvider.models?.subtitle] : []),
    ].filter(Boolean).join('\n\n');
    // A receiving executor's carried review with host-discovered facts (the command a Service starts, a deploy's
    // effect, its included steps) reads through the approval family presenters, not as a bare sentence.
    const reviewFacts = preview !== undefined
      ? await import('@/components/approvals/ActionConfirmationReview') : null;
    const confirmed = reviewFacts
      ? await reviewFacts.confirmActionReview({ actionId, actionArgs: input, preview,
        summaryPlacement: 'host',
        title: actionId === 'account.delete' ? t('settingsAccount.deleteAccountConfirmTitle') : presentation.title ?? t('approvals.untitled'),
        summary: confirmationSummary || null,
        confirmLabel: actionId === 'account.delete' ? t('settingsAccount.deleteAccount') : presentation.confirmLabel ?? t('approvals.approve'),
        ...(actionId === 'account.delete' ? { typedConfirmation: { text: 'DELETE', placeholder: 'DELETE',
          instruction: t('settingsAccount.deleteAccountConfirmBody') } } : {}),
        irreversible: getActionSpec(actionId).irreversible === true, destructive: presentation.destructive === true,
        serverId: accountContext.serverId, ...(context.signal ? { signal: context.signal } : {}) })
      : actionId === 'account.delete'
      ? await Modal.prompt(t('settingsAccount.deleteAccountConfirmTitle'), t('settingsAccount.deleteAccountConfirmBody'), {
        placeholder: 'DELETE', confirmText: t('settingsAccount.deleteAccount'),
      }) === 'DELETE'
      : await Modal.confirm(presentation.title ?? t('approvals.untitled'), confirmationSummary,
        { ...(presentation.confirmLabel ? { confirmText: presentation.confirmLabel } : {}),
          ...(presentation.destructive ? { destructive: true } : {}),
          ...(context.signal ? { signal: context.signal } : {}), });
    // Let the Action owner project invocation cancellation before checking
    // Account currentness, which also throws for an aborted invocation.
    if (context.signal?.aborted) return false;
    accountContext.assertCurrent();
    return confirmed;
  };
}
