import { BrowserExtensionMutationResultV1Schema } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { BrowserExtensionWebStoreSourceV1 } from '@happier-dev/protocol/browser/profile/extensionsV1';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createActionInputForm, type ActionInputFormSubmissionResult } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Store install, Updates and a profile's Extensions section present the browser owner's permission and
 * restart decisions alike: one review, one restart confirmation, then the same Action again.
 */
export async function submitBrowserExtensionMutation(params: Readonly<{
    actionId: 'browser.extensions.install' | 'browser.extensions.update' | 'browser.extensions.enable'
        | 'browser.extensions.disable' | 'browser.extensions.remove';
    input: Readonly<Record<string, unknown>>;
    machineId: string;
    execute: ReturnType<typeof useMountedActionExecution>['execute'];
    signal: AbortSignal;
    confirmText: string;
}>): Promise<ActionInputFormSubmissionResult> {
    let input = params.input;
    for (;;) {
        const response = await params.execute(params.actionId, input,
            { signal: params.signal, externalActionTarget: { kind: 'machine', machineId: params.machineId } });
        if (!response.ok) return { ok: false, code: response.errorCode };
        const result = BrowserExtensionMutationResultV1Schema.parse(response.result);
        if (result.status === 'updated' || result.status === 'removed') return { ok: true };
        if (result.status === 'unavailable') return { ok: false, code: result.code };
        if (result.status === 'needs_review') {
            const { showStoreBrowserExtensionReview } = await import('./StoreSoftwareReview');
            if (!await showStoreBrowserExtensionReview({ review: result.review, restartRequired: result.restartRequired === true,
                confirmText: params.confirmText, signal: params.signal })) return { ok: false, cancelled: true };
            input = { ...input, reviewedPermissions: result.review };
        } else {
            if (!await Modal.confirm(t('capabilities.store.browserExtensionInstall.restartTitle'),
                t('capabilities.store.browserExtensionInstall.restartBody'),
                { confirmText: t('common.continue'), signal: params.signal })) return { ok: false, cancelled: true };
            input = { ...input, restartConfirmed: true };
        }
    }
}

/**
 * The install form a Store listing and a pasted Chrome Web Store link both open: pick the Machine and the saved
 * profile (seeded when a profile's Extensions section opened the Store), then the same install Action.
 */
export function presentBrowserExtensionInstallForm(params: Readonly<{
    title: string;
    description: string | null;
    source: BrowserExtensionWebStoreSourceV1 | Readonly<{ kind: 'unpacked'; directory: string }>;
    execution: Pick<ReturnType<typeof useMountedActionExecution>, 'binding' | 'execute' | 'getSignal'>;
    seedMachineId: string | null;
    seedProfileId: string | null;
}>): void {
    const { execution, source } = params;
    if (!execution.binding) return;
    const spec = getActionSpec('browser.extensions.install');
    // The spec's own hint title and description are the Action's; the person reads what they are adding instead
    // (the Store item's name, or the link it came from), so the caller's title is the sheet's title.
    // The sheet's title is a name, so its primary button carries the verb.
    const { description: _agentFacingDescription, title: _actionTitle, ...inputHints } = spec.inputHints!;
    const form = createActionInputForm({
        presentation: { title: params.title, description: params.description,
            inputHints: { ...inputHints, submitLabel: t('capabilities.store.add'), fields: inputHints.fields.filter(field =>
                field.path === 'machineId' || field.path === 'profileId') } },
        accountLifetime: execution.binding, signal: execution.getSignal(),
        initialInput: { ...(params.seedMachineId ? { machineId: params.seedMachineId } : {}),
            ...(params.seedProfileId ? { profileId: params.seedProfileId } : {}) },
        submit: (candidate, { signal }) => submitBrowserExtensionMutation({
            actionId: 'browser.extensions.install', input: { ...candidate, source },
            machineId: typeof candidate.machineId === 'string' ? candidate.machineId : '',
            execute: execution.execute, signal, confirmText: t('capabilities.store.add'),
        }),
    });
    presentActionInputForm({ form, signal: execution.getSignal(), actionId: spec.id });
}
