import {
    PluginUiArtifactIntegrityBindingV1Schema,
    type PluginUiArtifactIntegrityBindingV1,
} from '@happier-dev/protocol';

export function defineUiArtifactIntegrity<const TIntegrity extends PluginUiArtifactIntegrityBindingV1>(
    integrity: TIntegrity,
): TIntegrity {
    return PluginUiArtifactIntegrityBindingV1Schema.parse(integrity) as TIntegrity;
}

export type {
    PluginUiArtifactIntegrityBindingV1,
} from '@happier-dev/protocol';
