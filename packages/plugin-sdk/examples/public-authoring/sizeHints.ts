import type { ActionInputHints } from '@happier-dev/plugin-sdk/actions';

/** Options Action fields for a local provisioner's saved launch choices. */
export const savedSizeInputHints = {
    fields: [
        { path: 'cores', title: 'CPU cores', widget: 'integer', role: 'cpu' },
        { path: 'ram', title: 'Memory', widget: 'integer', unit: 'bytes', role: 'memory' },
        { path: 'storage', title: 'Disk (GiB)', widget: 'integer', role: 'disk' },
        { path: 'system', title: 'System image', widget: 'text', role: 'image' },
    ],
} satisfies ActionInputHints;
