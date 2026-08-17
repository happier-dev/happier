import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

/**
 * The public build owner emits the complete hosted graph from this one entry.
 * The plugin names no source URL or artifact manifest; it only declares the
 * build input that corresponds to the cold renderer contribution.
 */
export const pluginUiBuildConfig = defineBuildConfig({
    projectRoot: '.',
    outDir: 'dist/ui',
    targets: [{
        rendererId: 'review-hosted',
        entry: 'ui/reviewPanel.web.ts',
        kind: 'hostedWeb',
    }],
});

export default pluginUiBuildConfig;
