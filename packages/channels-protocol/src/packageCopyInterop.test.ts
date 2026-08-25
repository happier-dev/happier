import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runBoundedChildProcess } from '../test/boundedChildProcess.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

const requiredBuiltEntrypoints = [
    'dist/index.js',
    'dist/v1/index.js',
    'dist/testing/v1/index.js',
] as const;

async function missingBuiltEntrypoints(): Promise<string[]> {
    const missing: string[] = [];
    for (const relativePath of requiredBuiltEntrypoints) {
        try {
            await access(join(packageRoot, relativePath));
        } catch {
            missing.push(relativePath);
        }
    }
    return missing;
}

async function copyInstalledPackage(consumerRoot: string): Promise<void> {
    const packageDirectory = join(
        consumerRoot,
        'node_modules',
        '@happier-dev',
        'channels-protocol',
    );
    await mkdir(packageDirectory, { recursive: true });
    await Promise.all([
        cp(join(packageRoot, 'package.json'), join(packageDirectory, 'package.json')),
        cp(join(packageRoot, 'dist'), join(packageDirectory, 'dist'), { recursive: true }),
    ]);
}

async function linkRuntimeDependencies(consumerRoot: string): Promise<void> {
    const scopeDirectory = join(consumerRoot, 'node_modules', '@happier-dev');
    await mkdir(scopeDirectory, { recursive: true });
    await Promise.all([
        symlink(
            join(repositoryRoot, 'packages', 'plugin-sdk'),
            join(scopeDirectory, 'plugin-sdk'),
            'junction',
        ),
        symlink(
            join(packageRoot, 'node_modules', 'zod'),
            join(consumerRoot, 'node_modules', 'zod'),
            'junction',
        ),
    ]);
}

describe('Channels protocol separately resolved copies', { timeout: 45_000 }, () => {
    it('bounds package-artifact child processes by deadline and captured output', async () => {
        await expect(runBoundedChildProcess({
            label: 'slow Channels package-artifact fixture',
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 250)'],
            cwd: packageRoot,
            timeoutMs: 25,
            maxOutputBytes: 1_024,
        })).rejects.toThrow('timed out after 25ms');

        await expect(runBoundedChildProcess({
            label: 'verbose Channels package-artifact fixture',
            command: process.execPath,
            args: ['-e', "process.stdout.write('x'.repeat(4096))"],
            cwd: packageRoot,
            timeoutMs: 5_000,
            maxOutputBytes: 1_024,
        })).rejects.toThrow('exceeded 1024 output bytes');

        await expect(runBoundedChildProcess({
            label: 'failing Channels package-artifact fixture',
            command: process.execPath,
            args: ['-e', "console.log('stdout-proof'); console.error('stderr-proof'); process.exitCode = 1"],
            cwd: packageRoot,
            timeoutMs: 5_000,
            maxOutputBytes: 1_024,
        })).rejects.toThrow(/stdout:\s+stdout-proof[\s\S]*stderr:\s+stderr-proof/u);
    });

    it('exchanges serialized V1 values without schema object identity', async () => {
        const missing = await missingBuiltEntrypoints();
        expect(
            missing,
            `built Channels protocol artifacts are required for copy-isolated interoperability; run `
            + '`yarn workspace @happier-dev/channels-protocol build`'
            + ` before this test (missing: ${missing.join(', ') || 'none'})`,
        ).toEqual([]);

        const isolationRoot = await mkdtemp(join(tmpdir(), 'happier-channels-protocol-copy-interop-'));
        try {
            const consumerRoots = [
                join(isolationRoot, 'consumer-a'),
                join(isolationRoot, 'consumer-b'),
            ] as const;
            await Promise.all(consumerRoots.map(async (consumerRoot) => {
                await mkdir(consumerRoot, { recursive: true });
                await copyInstalledPackage(consumerRoot);
                await linkRuntimeDependencies(consumerRoot);
            }));

            const runnerPath = join(isolationRoot, 'run.mjs');
            const consumerEntryUrls = consumerRoots.map((consumerRoot) => pathToFileURL(
                join(consumerRoot, 'entry.mjs'),
            ).href);
            await writeFile(runnerPath, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireA = createRequire(${JSON.stringify(consumerEntryUrls[0])});
const requireB = createRequire(${JSON.stringify(consumerEntryUrls[1])});
const importResolved = (requireFromConsumer, specifier) =>
  import(pathToFileURL(requireFromConsumer.resolve(specifier)).href);
const rootA = await importResolved(requireA, '@happier-dev/channels-protocol');
const v1A = await importResolved(requireA, '@happier-dev/channels-protocol/v1');
const testingA = await importResolved(requireA, '@happier-dev/channels-protocol/testing/v1');
const rootB = await importResolved(requireB, '@happier-dev/channels-protocol');
const v1B = await importResolved(requireB, '@happier-dev/channels-protocol/v1');
const testingB = await importResolved(requireB, '@happier-dev/channels-protocol/testing/v1');

assert.strictEqual(rootA.ConversationProviderSetupResultV1Schema, v1A.ConversationProviderSetupResultV1Schema);
assert.strictEqual(rootB.ConversationProviderSetupResultV1Schema, v1B.ConversationProviderSetupResultV1Schema);

assert.notEqual(
  requireA.resolve('@happier-dev/channels-protocol/v1'),
  requireB.resolve('@happier-dev/channels-protocol/v1'),
  'the two consumers must resolve distinct package copies',
);
assert.notStrictEqual(
  v1A.ConversationProviderSetupResultV1Schema,
  v1B.ConversationProviderSetupResultV1Schema,
  'serialized compatibility must not depend on schema object identity',
);
assert.deepEqual(
  JSON.parse(JSON.stringify({
    id: v1A.ConversationProvidersContributionProtocolV1.id,
    version: v1A.ConversationProvidersContributionProtocolV1.version,
  })),
  {
    id: v1B.ConversationProvidersContributionProtocolV1.id,
    version: v1B.ConversationProvidersContributionProtocolV1.version,
  },
  'the V1 contribution protocol identity must be shared as serialized data',
);

const setupA = testingA.createConversationProviderSetupResultV1Fixture({
  providerConnectionKey: 'copy-a:provider',
  providerConfig: { installation: 'copy-a' },
});
const setupWire = JSON.parse(JSON.stringify(setupA));
assert.deepEqual(v1B.ConversationProviderSetupResultV1Schema.parse(setupWire), setupA);
assert.equal(
  testingB.createConversationProviderSetupResultV1Fixture({ providerConnectionKey: 'copy-b:provider' })
    .providerConnectionKey,
  'copy-b:provider',
  'the second separately resolved copy must expose its own public testkit',
);

const observationA = v1A.ConversationProviderObservationIngestInputV1Schema.parse({
  connectionId: 'connection-copy-a',
  entry: {
    observation: {
      kind: 'fullText',
      observation: {
        v: 1,
        occurrenceId: 'copy-a:occurrence:1',
        occurredAt: 1_700_000_000_000,
        transport: { kind: 'poll', providerDeliveryId: 'copy-a:delivery:1' },
        endpoint: { kind: 'direct', audience: 'direct', id: 'copy-a:conversation' },
        actor: { principalId: 'copy-a:human', kind: 'human', isIntegrationSelf: false },
        message: {
          id: 'copy-a:message:1',
          text: 'serialized V1 interop',
          addressingEvidence: 'none',
          contentProvenance: 'original',
          providerTimestamp: 1_700_000_000_000,
        },
      },
    },
    eventCandidate: null,
  },
});
assert.deepEqual(
  v1B.ConversationProviderObservationIngestInputV1Schema.parse(
    JSON.parse(JSON.stringify(observationA)),
  ),
  observationA,
);

assert.throws(
  () => v1B.ConversationProviderSetupResultV1Schema.parse({
    ...setupWire,
    unexpected: true,
  }),
  'copy B must enforce the V1 closed unknown-key policy',
);
assert.throws(
  () => v1B.ConversationProviderSetupResultV1Schema.parse({
    ...setupWire,
    providerConnectionKey: 'x'.repeat(513),
  }),
  'copy B must enforce the V1 provider-connection-key bound',
);
`, 'utf8');

            await runBoundedChildProcess({
                label: 'Channels separately resolved copies runner',
                command: process.execPath,
                args: [runnerPath],
                cwd: isolationRoot,
                timeoutMs: 30_000,
                maxOutputBytes: 1_000_000,
            });
        } finally {
            await rm(isolationRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    });
});
