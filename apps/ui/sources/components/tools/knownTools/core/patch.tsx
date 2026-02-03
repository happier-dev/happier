import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { PatchInputV2Schema } from '@happier-dev/protocol';

export const corePatchTools = {
    Patch: {
        title: t('tools.names.applyChanges'),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: PatchInputV2Schema,
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const changes = opts.tool.input?.changes;
            if (!changes || typeof changes !== 'object') return null;
            const files = Object.keys(changes as Record<string, unknown>);
            if (files.length === 0) return null;
            if (files.length === 1) {
                const fileName = files[0].split('/').pop() || files[0];
                return fileName;
            }
            return t('tools.desc.modifyingFiles', { count: files.length });
        },
    },
} satisfies Record<string, KnownToolDefinition>;
