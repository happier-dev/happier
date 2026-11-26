import { definePlugin } from '@happier-dev/plugin-sdk';
import { definePluginDeclarativeDocumentV1, PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';

// Independent author example: presentation of namespaced facts, not Review authority.
const runtime: PluginDynamicResourceRuntime = {
    read({ context }) {
        const review = context.kind === 'surface' ? context.review : undefined;
        const extension = review?.kind === 'finding' && review.namespace === 'example.review-evidence'
            ? review.extension : null;
        const evidence = extension && typeof extension === 'object' && !Array.isArray(extension)
            && 'reproduction' in extension && typeof extension.reproduction === 'string'
            ? extension.reproduction : 'Open a finding to read its reproduction.';
        return JSON.stringify(definePluginDeclarativeDocumentV1({ version: 1, root: {
            kind: 'group', title: 'Reproduction', children: [{ kind: 'text', text: evidence }],
        } }));
    },
    observe() { return { dispose() {} }; },
};

const plugin = definePlugin({
    id: 'example.review-evidence', version: '1.0.0', displayName: 'Review evidence',
    entrypoints: { daemon: './reviewContributions.ts' },
    ui: {
        views: [
            { id: 'finding', container: 'reviewFinding', target: { kind: 'app' }, renderer: 'evidence-renderer', title: 'Evidence' },
            { id: 'story', container: 'appPage', target: { kind: 'app', context: 'review' }, renderer: 'evidence-renderer', title: 'Review story' },
        ],
        renderers: [{ id: 'evidence-renderer', kind: 'declarative', root: { kind: 'text', text: 'Evidence unavailable.' },
            documentSource: { kind: 'resource', resourceId: 'evidence' } }],
    },
    resources: { evidence: {
        source: 'dynamic', kind: 'config', contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
        // The declarative-document contract requires an explicit ceiling of at most 512 KiB.
        maxBytes: 512 * 1024, scope: 'surface', execution: { target: 'daemon' }, runtime,
    } },
});

export const manifest = plugin.manifest;
export const activate = plugin.activate;
