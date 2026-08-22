import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('runner managed-service credential-file composition', () => {
    it('shares one runner-owned private file materializer across Agent and managed Provider services', async () => {
        const source = await readFile(
            new URL('./createRunnerManagedServiceInvocationOwner.ts', import.meta.url),
            'utf8',
        );

        expect(source.match(/createManagedServiceCredentialFileOwner\(\s*\{\s*rootDir:\s*join\(\s*input\.paths\.secretsDir,\s*'managed-services',?\s*\),?\s*\},?\s*\)/gu))
            .toHaveLength(1);
        expect(source.match(/credentialFiles:\s*managedServiceCredentialFileOwner/gu))
            .toHaveLength(2);
        expect(source).toMatch(/createPluginInvocationServicesFactory\(\s*\{[\s\S]*?managedServiceCredentialFiles:\s*managedServiceCredentialFileOwner[\s\S]*?\}\s*\)/u);
        expect(source).not.toMatch(/credentialFiles:\s*null/gu);
    });

    it('does not assemble a runner-local events owner beside the daemon broker', async () => {
        const source = await readFile(
            new URL('./createRunnerManagedServiceInvocationOwner.ts', import.meta.url),
            'utf8',
        );

        expect(source).not.toContain(
            'createProductionPluginInvocationServiceOwners',
        );
        expect(source).not.toContain('createStablePluginEventsBroker');
    });
});
