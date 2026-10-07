import {
    LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
} from '@happier-dev/agents';

import type { Metadata } from '@happier-dev/session-core/state';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { readSessionModesMetadata, type SessionOwnerModeCatalogV2 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

type SessionModesState = SessionOwnerModeCatalogV2;
type SessionModelsState = NonNullable<Metadata['sessionModelsV1'] | Metadata['acpSessionModelsV1']>;
type SessionConfigOptionsState = NonNullable<Metadata['sessionConfigOptionsV1'] | Metadata['acpConfigOptionsV1']>;

function readMetadata(metadata: Metadata | ComposerOptionsInputV1 | null | undefined): Record<string, unknown> {
    return ((metadata as unknown) ?? {}) as Record<string, unknown>;
}

export function readSessionModesState(metadata: Metadata | null | undefined): SessionModesState | null {
    return readSessionModesMetadata(readMetadata(metadata));
}

export function readSessionModelsState(metadata: ComposerOptionsInputV1 | null | undefined): SessionModelsState | null {
    return readMetadataAliasValue<SessionModelsState>(
        readMetadata(metadata),
        SESSION_MODELS_STATE_KEY,
        LEGACY_ACP_SESSION_MODELS_STATE_KEY,
    ) ?? null;
}

export function readSessionConfigOptionsState(metadata: Metadata | null | undefined): SessionConfigOptionsState | null {
    return readMetadataAliasValue<SessionConfigOptionsState>(
        readMetadata(metadata),
        SESSION_CONFIG_OPTIONS_STATE_KEY,
        LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY,
    ) ?? null;
}
