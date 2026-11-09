import { describe, expect, it } from 'vitest';

import unitConfig from '../vitest.config.ts';
import integrationConfig from '../vitest.integration.config.ts';
import externalSessionMaterializeConfig from '../vitest.externalSessionMaterialize.integration.config.ts';

type SourcePlugin = Readonly<{
    name?: string;
    resolveId?: (id: string) => string | null;
}>;

function workspaceSourcesPlugin(config: { plugins?: unknown[] }): SourcePlugin | undefined {
    return config.plugins?.find((candidate): candidate is SourcePlugin => (
        Boolean(candidate)
        && typeof candidate === 'object'
        && 'name' in candidate
        && candidate.name === 'happier-server-workspace-package-sources'
    ));
}

describe('server source validation', () => {
    it('uses the canonical workspace-source resolver in every ordinary Vitest lane', () => {
        for (const config of [unitConfig, integrationConfig, externalSessionMaterializeConfig]) {
            const plugin = workspaceSourcesPlugin(config);
            expect(plugin?.resolveId?.('@happier-dev/protocol')).toContain('/packages/protocol/src/index.ts');
            expect(plugin?.resolveId?.('@happier-dev/plugins-kiro/agent/acp/transport'))
                .toContain('/packages/plugins/kiro/src/agent/acp/transport.ts');
            expect(plugin?.resolveId?.('@happier-dev/sync-client'))
                .toContain('/packages/sync-client/src/index.ts');
            expect(plugin?.resolveId?.('@happier-dev/sdk'))
                .toContain('/packages/sdk/src/index.public.ts');
            expect(plugin?.resolveId?.('@happier-dev/channels-protocol/v1'))
                .toContain('/packages/channels-protocol/src/v1/index.ts');
            expect(plugin?.resolveId?.('@happier-dev/cli-common/fs/jsonOwnerFileLock'))
                .toContain('/packages/cli-common/src/fs/jsonOwnerFileLock.ts');
        }
    });

    it('does not retain a first-party package alias beside the source resolver', () => {
        for (const config of [integrationConfig, externalSessionMaterializeConfig]) {
            expect(config.resolve?.alias ?? []).toEqual([]);
        }
    });

    it('keeps the source-built Home Iroh test out of the ordinary integration lane', () => {
        expect(integrationConfig.test?.exclude).toContain(
            'sources/app/iroh/homeIrohEndpoint.real.integration.test.ts',
        );
    });
});
