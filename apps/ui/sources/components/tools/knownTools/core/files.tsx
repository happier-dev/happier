import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
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
} from '@happier-dev/protocol';

export const coreFileTools = {
    'Read': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            // Gemini uses 'locations' array with 'path' field
            if (Array.isArray(opts.tool.input.locations)) {
                const maybePath = opts.tool.input.locations[0]?.path;
                if (typeof maybePath === 'string' && maybePath.length > 0) {
                    const path = resolvePath(maybePath, opts.metadata);
                    return path;
                }
            }
            return t('tools.names.readFile');
        },
        minimal: true,
        icon: ICON_READ,
        input: ReadInputV2Schema,
        result: ReadResultV2Schema,
    },
    // Gemini uses lowercase 'read'
    'read': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Gemini uses 'locations' array with 'path' field
            if (Array.isArray(opts.tool.input.locations)) {
                const maybePath = opts.tool.input.locations[0]?.path;
                if (typeof maybePath === 'string' && maybePath.length > 0) {
                    const path = resolvePath(maybePath, opts.metadata);
                    return path;
                }
            }
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.readFile');
        },
        minimal: true,
        icon: ICON_READ,
        input: ReadInputV2Schema,
    },
    'Edit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: EditInputV2Schema,
    },
    'MultiEdit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 1) {
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
                }
                return path;
            }
            return t('tools.names.editFile');
        },
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
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.writeFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: WriteInputV2Schema,
    },
    'Delete': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const input = opts.tool.input as any;
            const filePaths = Array.isArray(input?.file_paths) ? input.file_paths : null;
            const first = Array.isArray(filePaths) && typeof filePaths[0] === 'string' ? String(filePaths[0]) : null;
            const fallback = typeof input?.file_path === 'string' ? String(input.file_path) : null;
            const path = first || fallback ? resolvePath(first ?? fallback ?? '', opts.metadata) : null;
            const count = Array.isArray(filePaths) ? filePaths.length : (first || fallback ? 1 : 0);
            if (path && count > 1) return `${path} (+${count - 1} more)`;
            if (path) return path;
            return 'Delete';
        },
        icon: ICON_DELETE,
        isMutable: true,
        input: DeleteInputV2Schema,
    },
} satisfies Record<string, KnownToolDefinition>;
