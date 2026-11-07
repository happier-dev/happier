import { BrowserExtensionMutationResultV1Schema } from '@happier-dev/protocol/actions';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ActionInputFormSubmissionResult } from '@/components/plugins/actions/actionInputForm';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Store install and Updates present the browser owner's permission and restart decisions alike. */
export async function submitBrowserExtensionMutation(params: Readonly<{
    actionId: 'browser.extensions.install' | 'browser.extensions.update';
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
        if (result.status === 'updated') return { ok: true };
        if (result.status === 'unavailable') return { ok: false, code: result.code };
        if (result.status === 'removed') return { ok: false };
        if (result.status === 'needs_review') {
            const body = [result.review.version, ...result.review.permissions, ...result.review.hostPermissions,
                ...(result.restartRequired ? [t('capabilities.store.browserExtensionInstall.restartBody')] : [])].join('\n');
            if (!await Modal.confirm(t('capabilities.store.browserExtensionInstall.reviewTitle'), body,
                { confirmText: params.confirmText, signal: params.signal })) return { ok: false };
            input = { ...input, reviewedPermissions: result.review };
        } else {
            if (!await Modal.confirm(t('capabilities.store.browserExtensionInstall.restartTitle'),
                t('capabilities.store.browserExtensionInstall.restartBody'),
                { confirmText: t('common.continue'), signal: params.signal })) return { ok: false };
            input = { ...input, restartConfirmed: true };
        }
    }
}
