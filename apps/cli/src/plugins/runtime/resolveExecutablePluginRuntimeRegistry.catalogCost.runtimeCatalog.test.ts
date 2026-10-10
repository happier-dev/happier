import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

function cpuMicroseconds(start: NodeJS.CpuUsage): number {
    const elapsed = process.cpuUsage(start);
    return elapsed.user + elapsed.system;
}

describe('Agent catalog acquisition cost', () => {
    it('projects a warm Agent without paying for whole-catalog schema admission on each lookup', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture();
        try {
            const runtime = fixture.registry;
            const first = await runtime.acquireAgentCatalogEntry('claude');
            expect(first).not.toBeNull();
            // Compare CPU, not wall time or an invented production deadline.
            // A warm leaf lookup must cost less than rebuilding every family.
            const rebuildStart = process.cpuUsage();
            for (let i = 0; i < 3; i += 1) createResolvedContributionRegistry(runtime.contributes);
            const rebuildCpu = cpuMicroseconds(rebuildStart);
            const lookupStart = process.cpuUsage();
            for (let i = 0; i < 3; i += 1) {
                expect(await runtime.acquireAgentCatalogEntry('claude')).toMatchObject({ id: first?.id });
            }
            // The bundled catalog spans dozens of plugins/families. Warm
            // single-Agent projection should consume only a small fraction of
            // that work, not merely be marginally faster than a full rebuild.
            const lookupCpu = cpuMicroseconds(lookupStart);
            expect(lookupCpu).toBeLessThan(rebuildCpu / 10);
        } finally {
            await fixture.dispose();
        }
    }, 120_000);
});
