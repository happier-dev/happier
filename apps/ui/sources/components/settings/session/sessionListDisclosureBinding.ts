import { z } from 'zod/mini';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { collapsedGroupsState, replaceCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';

const collapseMapSchema = z.record(z.string(), z.boolean());

/** Compatibility Settings Actions reach the same device owner as mounted disclosure controls. */
export const sessionListDisclosureBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', resetValue: {},
    read: () => collapsedGroupsState.readAll(),
    parse: (value: unknown) => {
        const parsed = collapseMapSchema.safeParse(value);
        return parsed.success ? { success: true as const, value: parsed.data } : { success: false as const };
    },
    commit: (_local, value) => { replaceCollapsedGroupKeys(collapseMapSchema.parse(value)); },
} satisfies Extract<SettingStorageBinding, { scope: 'local'; kind: 'localOwner' }>;
