import { createKnownToolTitle } from '../toolTitles';
import type { Metadata } from '@happier-dev/session-core/state';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { resolvePath } from '@/utils/path/pathUtils';
import { t } from '@/text';
import { ICON_READ, ICON_EDIT, ICON_DELETE } from '../icons';
import type { KnownToolDefinition } from '../_types';
import {
    DeleteInputV2Schema,
    EditInputV2Schema,
    MultiEditInputV2Schema,
    ReadInputV2Schema,
    ReadResultV2Schema,
    WriteInputV2Schema,
} from '@happier-dev/protocol/tools/v2/schemas';

export const coreFileTools = {
    'Read': {
        title: createKnownToolTitle("Read"),
        minimal: true,
        icon: ICON_READ,
        input: ReadInputV2Schema,
        result: ReadResultV2Schema,
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path.trim().length > 0 ? path : null;
            }
            // Gemini uses 'locations' array with 'path' field
            if (Array.isArray(opts.tool.input.locations)) {
                const maybePath = opts.tool.input.locations[0]?.path;
                if (typeof maybePath === 'string' && maybePath.length > 0) {
                    const path = resolvePath(maybePath, opts.metadata);
                    return path.trim().length > 0 ? path : null;
                }
            }
            return null;
        },
    },
    // Gemini uses lowercase 'read'
    'read': {
        title: createKnownToolTitle("read"),
        minimal: true,
        icon: ICON_READ,
        input: ReadInputV2Schema,
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Gemini uses 'locations' array with 'path' field
            if (Array.isArray(opts.tool.input.locations)) {
                const maybePath = opts.tool.input.locations[0]?.path;
                if (typeof maybePath === 'string' && maybePath.length > 0) {
                    const path = resolvePath(maybePath, opts.metadata);
                    return path.trim().length > 0 ? path : null;
                }
            }
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path.trim().length > 0 ? path : null;
            }
            return null;
        },
    },
    'Edit': {
        title: createKnownToolTitle("Edit"),
        icon: ICON_EDIT,
        isMutable: true,
        input: EditInputV2Schema,
    },
    'MultiEdit': {
        title: createKnownToolTitle("MultiEdit"),
        icon: ICON_EDIT,
        isMutable: true,
        input: MultiEditInputV2Schema,
        extractStatus: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 0) {
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
                }
                return path;
            }
            return null;
        }
    },
    'Write': {
        title: createKnownToolTitle("Write"),
        icon: ICON_EDIT,
        isMutable: true,
        input: WriteInputV2Schema,
    },
    'Delete': {
        title: createKnownToolTitle("Delete"),
        icon: ICON_DELETE,
        isMutable: true,
        input: DeleteInputV2Schema,
    },
} satisfies Record<string, KnownToolDefinition>;
