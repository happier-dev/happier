import { z } from 'zod/mini';

import { createPersistentUiState } from '@/sync/domains/state/persistentUiState';

const StepIdsSchema = z.array(z.string());

export const installedPluginSetupDismissals = createPersistentUiState<readonly string[]>(
    'installed-plugin-setup-dismissals-v1',
    value => z.catch(StepIdsSchema, []).parse(value),
);

export function skipInstalledPluginSetupStep(dismissalKey: string, stepId: string): void {
    const skipped = installedPluginSetupDismissals.readStrict(dismissalKey) ?? [];
    if (!skipped.includes(stepId)) installedPluginSetupDismissals.set(dismissalKey, [...skipped, stepId]);
}
