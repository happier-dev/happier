import {
    PluginAccountDataEraseActionInputV1Schema,
    PluginAccountDataEraseActionOutputV1Schema,
    type ActionExecuteResult,
} from '@happier-dev/protocol';

import { Modal, type IModal } from '@/modal';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

export type PluginAccountDataEraseRecoveryExecute = ReturnType<typeof createFrontDoorActionExecute>;

type PluginAccountDataEraseRecoveryModal = Pick<IModal, 'alert' | 'confirm' | 'prompt'>;

export type PluginAccountDataEraseRecoveryDependencies = Readonly<{
    execute: PluginAccountDataEraseRecoveryExecute;
    modal: PluginAccountDataEraseRecoveryModal;
    captureActiveAccountScopeLifetime(): ActiveServerAccountScopeLifetime | null;
}>;

export type PluginAccountDataEraseRecoveryController = Readonly<{
    eraseKnownPlugin(pluginId: string): Promise<void>;
    eraseOrphanedPlugin(): Promise<void>;
    retire(): void;
    isPending(): boolean;
}>;

const defaultDependencies: PluginAccountDataEraseRecoveryDependencies = Object.freeze({
    execute: createFrontDoorActionExecute(),
    modal: Modal,
    captureActiveAccountScopeLifetime: captureActiveServerAccountScopeLifetime,
});

function completedMessage(changed: boolean): string {
    return changed
        ? t('settingsPlugins.accountDataErase.completedChanged')
        : t('settingsPlugins.accountDataErase.completedEmpty');
}

function incompletePrompt(result: unknown): Readonly<{ title: string; body: string }> {
    const parsed = PluginAccountDataEraseActionOutputV1Schema.safeParse(result);
    if (!parsed.success) {
        return {
            title: t('settingsPlugins.accountDataErase.unavailableTitle'),
            body: t('settingsPlugins.accountDataErase.unavailableBody'),
        };
    }
    return parsed.data.status === 'failed'
        ? {
            title: t('settingsPlugins.accountDataErase.failedTitle'),
            body: t('settingsPlugins.accountDataErase.failedBody'),
        }
        : {
            title: t('settingsPlugins.accountDataErase.partialTitle'),
            body: t('settingsPlugins.accountDataErase.partialBody'),
        };
}

function parseCompletedOutput(result: ActionExecuteResult) {
    if (!result.ok) return null;
    const parsed = PluginAccountDataEraseActionOutputV1Schema.safeParse(result.result);
    return parsed.success ? parsed.data : null;
}

/**
 * Present-user controller for the one canonical Account plugin erase Action.
 * It owns confirmation, truthful feedback, and explicit retry presentation;
 * the Action owner below it owns both erase arms for each confirmed operation.
 */
export function createPluginAccountDataEraseRecoveryController(
    dependencies: PluginAccountDataEraseRecoveryDependencies = defaultDependencies,
): PluginAccountDataEraseRecoveryController {
    let retired = false;
    let activeController: AbortController | null = null;

    const isCurrent = (controller: AbortController): boolean => (
        !retired && activeController === controller && !controller.signal.aborted
    );

    const request = async (pluginIdInput: string | null): Promise<void> => {
        if (retired || activeController) return;
        const lifetime = dependencies.captureActiveAccountScopeLifetime();
        // The UI confirmation is bound to an already-current Account. Do not
        // allow a later Action invocation to select whichever Account happens
        // to become active after this recovery affordance was opened.
        if (!lifetime || !lifetime.isCurrent()) return;
        const controller = new AbortController();
        activeController = controller;
        const abort = () => controller.abort();
        const retirement = lifetime.onRetire(abort);

        try {
            const pluginId = pluginIdInput === null
                ? (await dependencies.modal.prompt(
                    t('settingsPlugins.accountDataErase.promptTitle'),
                    t('settingsPlugins.accountDataErase.promptBody'),
                    {
                        placeholder: t('settingsPlugins.accountDataErase.promptPlaceholder'),
                        confirmText: t('common.continue'),
                        cancelText: t('common.cancel'),
                    },
                ))?.trim() ?? ''
                : pluginIdInput.trim();
            if (!isCurrent(controller)) return;

            const input = PluginAccountDataEraseActionInputV1Schema.safeParse({ pluginId });
            if (!input.success) {
                dependencies.modal.alert(
                    t('settingsPlugins.accountDataErase.invalidTitle'),
                    t('settingsPlugins.accountDataErase.invalidBody'),
                );
                return;
            }

            const confirmed = await dependencies.modal.confirm(
                t('settingsPlugins.accountDataErase.confirmTitle'),
                t('settingsPlugins.accountDataErase.confirmBody', { pluginId: input.data.pluginId }),
                {
                    confirmText: t('settingsPlugins.accountDataErase.confirm'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            );
            if (!confirmed || !isCurrent(controller)) return;

            let actionResult: ActionExecuteResult;
            try {
                actionResult = await dependencies.execute(
                    'account.plugins.data.erase',
                    input.data,
                    {
                        surface: 'ui',
                        actionCaller: { kind: 'host' },
                        signal: controller.signal,
                    },
                );
            } catch {
                if (isCurrent(controller)) {
                    dependencies.modal.alert(
                        t('settingsPlugins.accountDataErase.unavailableTitle'),
                        t('settingsPlugins.accountDataErase.unavailableBody'),
                    );
                }
                return;
            }
            if (!isCurrent(controller)) return;

            const output = parseCompletedOutput(actionResult);
            if (!output) {
                dependencies.modal.alert(
                    t('settingsPlugins.accountDataErase.unavailableTitle'),
                    t('settingsPlugins.accountDataErase.unavailableBody'),
                );
                return;
            }
            if (output.status === 'completed') {
                const settingsChanged = output.settings.status === 'completed' && output.settings.changed;
                const dataChanged = output.data.status === 'completed' && output.data.changed;
                dependencies.modal.alert(
                    t('settingsPlugins.accountDataErase.completedTitle'),
                    completedMessage(settingsChanged || dataChanged),
                );
                return;
            }

            const prompt = incompletePrompt(output);
            dependencies.modal.alert(prompt.title, prompt.body);
        } finally {
            retirement.dispose();
            if (activeController === controller) activeController = null;
        }
    };

    return Object.freeze({
        eraseKnownPlugin: async (pluginId) => await request(pluginId),
        eraseOrphanedPlugin: async () => await request(null),
        retire(): void {
            retired = true;
            activeController?.abort();
        },
        isPending: () => activeController !== null,
    });
}
