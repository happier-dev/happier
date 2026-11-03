import type { ProviderErrorV1, SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';
import type { DaemonProviderBindingStatusResponseV1 } from '@happier-dev/protocol/rpc';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { presentProviderError, type ProviderErrorPresentation } from '@/providers/connection/errorPresentation';

export type SessionProviderBindingBanner = Readonly<{
    providerName: string;
    connectionName: string;
} & (
    | { kind: 'changed' | 'unavailable' | 'disabled' | 'incompatible'; action: 'restart' | 'choose-model' }
    | { kind: 'status-error'; action: 'retry'; errorPresentation: Pick<ProviderErrorPresentation, 'titleKey' | 'descriptionKey'> }
)>;

export function presentSessionProviderBinding(input: Readonly<{
    binding: SessionProviderBindingMetadataV1;
    status: DaemonProviderBindingStatusResponseV1 | Readonly<{ status: 'selection_changed' }> | null;
    error?: ProviderErrorV1 | null;
    proposedDisplay?: Readonly<{ providerName: string; connectionName: string }>;
}>): Readonly<{
    launchLabel: string;
    banner: SessionProviderBindingBanner | null;
}> {
    const snapshot = input.binding.displaySnapshot;
    const launchLabel = presentProviderConnectionIdentity({ providerName: snapshot.providerName,
        displayName: snapshot.connectionName, role: snapshot.connectionRole,
        displayNameMode: snapshot.connectionDisplayNameMode }).sourceLabel;
    const common = { providerName: snapshot.providerName, connectionName: snapshot.connectionName };
    const error = input.error ?? (input.status && 'error' in input.status && input.status.error.action === 'retry'
        ? input.status.error : null);
    if (error?.action === 'review_and_restart') {
        return { launchLabel, banner: { kind: 'changed', action: 'restart', ...common } };
    }
    if (error) {
        return { launchLabel, banner: { kind: 'status-error', action: 'retry', ...common,
            errorPresentation: presentProviderError(error) } };
    }
    switch (input.status?.status) {
        case undefined:
        case 'current':
            return { launchLabel, banner: null };
        case 'changed':
        case 'selection_changed':
            return {
                launchLabel,
                banner: {
                    kind: 'changed', action: 'restart',
                    ...(input.proposedDisplay ?? common),
                },
            };
        case 'connection_missing':
        case 'contribution_unavailable':
            return { launchLabel, banner: { kind: 'unavailable', action: 'choose-model', ...common } };
        case 'disabled':
        case 'grant_stale':
            return { launchLabel, banner: { kind: 'disabled', action: 'choose-model', ...common } };
        case 'incompatible':
            return { launchLabel, banner: { kind: 'incompatible', action: 'choose-model', ...common } };
    }
}
