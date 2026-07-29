import {
    SessionModelSelectionIntentV1Schema,
    type ProviderBoundModelRef,
    type SessionModelSelectionIntentV1,
} from '@happier-dev/protocol';

export function buildSessionModelSelectionIntent(input: Readonly<{
    updatedAt: number;
    ref: ProviderBoundModelRef | null;
}>): SessionModelSelectionIntentV1 {
    return SessionModelSelectionIntentV1Schema.parse({
        v: 1,
        updatedAt: input.updatedAt,
        selection: input.ref,
    });
}
