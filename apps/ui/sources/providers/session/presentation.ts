import type { ProviderErrorV1, SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';
import type { DaemonProviderBindingStatusResponseV1 } from '@happier-dev/protocol/rpc';

export type SessionProviderBindingBanner = Readonly<{
    kind: 'changed' | 'unavailable' | 'disabled' | 'incompatible' | 'status-error';
    action: 'restart' | 'choose-model' | 'retry';
    providerName: string;
    connectionName: string;
}>;

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
    const launchLabel = snapshot.connectionRole === 'default' && snapshot.connectionDisplayNameMode === 'automatic'
        ? snapshot.providerName
        : `${snapshot.providerName} · ${snapshot.connectionName}`;
    const common = { providerName: snapshot.providerName, connectionName: snapshot.connectionName };
    if (input.error) {
        return { launchLabel, banner: { kind: 'status-error', action: 'retry', ...common } };
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
