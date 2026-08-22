import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const servicesDir = dirname(fileURLToPath(import.meta.url));
const retiredModule = join(
    servicesDir,
    'runnerManagedServiceSupervisionGrantIdentity.ts',
);
const retiredTerms = Object.freeze([
    'RunnerAgentExecutionGrantV1',
    'grantDigest',
    'runtimeBindingDigest',
    'generationFingerprint',
    'supervisionGrantIdentity',
    'launchIdentityFingerprint',
    'createManagedServiceIdentityFingerprint',
]);
const directProviderCustodySources = Object.freeze([
    join(
        servicesDir,
        '../../../../agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol.ts',
    ),
    join(
        servicesDir,
        '../../../../agent/runtime/session/process/managedServiceEndpointReadProtocol.ts',
    ),
    join(
        servicesDir,
        '../../../../agent/runtime/session/process/runnerManagedServicesCustody.ts',
    ),
    join(
        servicesDir,
        '../../../../providers/lifecycle/publicManagedProviderRuntimeStart.ts',
    ),
    join(servicesDir, 'managedDependencies.ts'),
    join(servicesDir, 'managedDependencySourceAdapters.ts'),
    join(servicesDir, 'managedDependencySourceModel.ts'),
]);

describe('grant-free managed-service supervision architecture', () => {
    it('has no grant-derived supervision owner or identity reader', () => {
        expect(existsSync(retiredModule)).toBe(false);
        const productionSources = readdirSync(servicesDir)
            .filter((entry) => entry.endsWith('.ts'))
            .filter((entry) => !entry.endsWith('.test.ts'));
        for (const source of productionSources) {
            const contents = readFileSync(join(servicesDir, source), 'utf8');
            for (const term of retiredTerms) {
                expect(contents, `${source} retains ${term}`).not.toContain(
                    term,
                );
            }
        }
    });

    it('keeps manifest digest out of direct Provider custody and runtime authority', () => {
        for (const source of directProviderCustodySources) {
            const contents = readFileSync(source, 'utf8');
            expect(contents, `${source} retains manifestDigest`).not.toContain(
                'manifestDigest',
            );
        }
    });
});
