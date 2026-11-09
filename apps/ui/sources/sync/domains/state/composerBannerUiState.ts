import { z } from 'zod/mini';
import { createPersistentUiState, usePersistentUiStateValue } from './persistentUiState';

const BannerCollapseRecordSchema = z.record(z.string(), z.boolean());
const state = createPersistentUiState('composer-banner-collapse-v1', value => BannerCollapseRecordSchema.parse(value));
const EMPTY: Readonly<Record<string, boolean>> = {};
const KEY = 'collapsed';

export function readComposerBannerCollapse(): Readonly<Record<string, boolean>> {
    return state.read(KEY) ?? EMPTY;
}

export function useComposerBannerCollapseRecord(): Readonly<Record<string, boolean>> {
    return usePersistentUiStateValue(state, KEY) ?? EMPTY;
}

export function writeComposerBannerCollapse(record: Readonly<Record<string, boolean>>): void {
    state.set(KEY, BannerCollapseRecordSchema.parse(record));
}

/** An explicit empty record is current intent and wins over a retained Settings seed. */
export function migrateComposerBannerUiStateFromSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
    const record = settings as Record<string, unknown>;
    if (!Object.hasOwn(record, 'sessionComposerCollapsedBannerKinds')) return settings;
    const parsed = BannerCollapseRecordSchema.parse(record.sessionComposerCollapsedBannerKinds);
    if (state.readStrict(KEY) === undefined) state.set(KEY, parsed);
    const { sessionComposerCollapsedBannerKinds: _legacy, ...retained } = record;
    return retained;
}
