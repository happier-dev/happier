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
        }
    });

    it('does not retain a first-party package alias beside the source resolver', () => {
        for (const config of [integrationConfig, externalSessionMaterializeConfig]) {
            expect(config.resolve?.alias ?? []).toEqual([]);
        }
    });
});
