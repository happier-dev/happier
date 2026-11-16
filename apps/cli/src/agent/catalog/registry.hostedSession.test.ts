import { describe, expect, it } from 'vitest';
import { Session } from 'node:inspector';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { resolveCatalogAgentRequestCoverageOptions } from './registry';
import { PLUGIN_MANIFEST as claudeManifest } from '../../../../../packages/plugins/claude/src/manifest';

type Coverage = { result: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> };

// Precise coverage resets its counters on every take: a take before and after counts the run.
async function countRegistryBuilds<T>(run: () => T): Promise<{ value: T; builds: number }> {
    const inspector = new Session();
    const post = <R>(method: string, params?: Record<string, unknown>) => new Promise<R>((resolve, reject) => {
        inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as R));
    });
    inspector.connect();
    try {
        await post('Profiler.enable');
        await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        await post('Profiler.takePreciseCoverage');
        const value = run();
        const coverage = await post<Coverage>('Profiler.takePreciseCoverage');
        const builds = coverage.result.flatMap(script => script.functions)
            .filter(fn => fn.functionName === 'getResolvedContributionRegistry')
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
        return { value, builds };
    } finally {
        await new Promise<void>(resolve => inspector.post('Profiler.stopPreciseCoverage', () => resolve()));
        inspector.disconnect();
    }
}

// The daemon-admitted bootstrap a session host binds to the Session's scope (recorded producer shape).
function admittedClaudeBootstrap() {
    const definition = PluginAgentContributionV2Schema.parse(claudeManifest.contributes.agents?.[0]);
    return {
        definition,
        runnerBootstrap: {
            path: '/admitted/bootstrap.json',
            bootstrap: AgentRuntimeRunnerBootstrapV1Schema.parse({
                v: 1,
                descriptor: {
                    v: 1, pluginId: claudeManifest.id, pluginVersion: claudeManifest.version,
                    agentId: definition.id, backendId: definition.id, occurrenceId: 'recorded-admitted-runtime',
                    sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'recorded-admitted-runtime' } },
                    agentDeclaration: { provenance: 'first_party', source: { kind: 'bundled' }, definition },
                },
            }),
        },
    };
}

describe('Agent request coverage in a hosted Session', () => {
    it('reads the Session\'s admitted Agent declaration without building the full registry', async () => {
        const { definition, runnerBootstrap } = admittedClaudeBootstrap();
        expect(definition.requestCoverage).toBeDefined();
        const { value, builds } = await countRegistryBuilds(() => runAddedHostedSession({
            environment: {}, workingDirectory: '/admitted', end: () => {}, runnerBootstrap,
        }, () => resolveCatalogAgentRequestCoverageOptions({ agentId: definition.id })));
        expect(value).toEqual(definition.requestCoverage);
        expect(builds).toBe(0);
    });

    it('reads the catalog for an Agent other than the admitted one', async () => {
        const { runnerBootstrap } = admittedClaudeBootstrap();
        const { builds } = await countRegistryBuilds(() => runAddedHostedSession({
            environment: {}, workingDirectory: '/admitted', end: () => {}, runnerBootstrap,
        }, () => resolveCatalogAgentRequestCoverageOptions({ agentId: 'codex' })));
        expect(builds).toBeGreaterThan(0);
    });
});
