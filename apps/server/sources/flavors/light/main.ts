// This module only parses arguments and defers its database and identity
// owners, so importing it here costs the capability probe nothing.
import {
    readHomeOwnerClaimRequest,
    readPrintHomeClaimCodeRequest,
    runHomeOwnerClaimCommand,
    runPrintHomeClaimCodeCommand,
} from '@/app/home/governance/claimHomeOwnerCommand';
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';

const LIGHT_RUNTIME_CAPABILITY_PROBE_ARGUMENT = '--probe-runtime-capabilities';
const LIGHT_RUNTIME_CAPABILITY_PROBE_RESULT = {
    schemaVersion: 1,
    component: 'happier-server-light',
    capabilities: ['managed-personal-home-create.v1'],
} as const;

function readPositiveSafeIntegerArgument(argv: readonly string[], name: string): number | null {
    const prefix = `${name}=`;
    const direct = argv.find((argument) => argument.startsWith(prefix));
    const value = direct
        ? direct.slice(prefix.length)
        : (() => {
            const index = argv.indexOf(name);
            return index < 0 ? '' : String(argv[index + 1] ?? '');
        })();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed < Number.MAX_SAFE_INTEGER ? parsed : null;
}

export async function runLightServerMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    if (argv.includes(LIGHT_RUNTIME_CAPABILITY_PROBE_ARGUMENT)) {
        process.stdout.write(`${JSON.stringify(LIGHT_RUNTIME_CAPABILITY_PROBE_RESULT)}\n`);
        return;
    }

    await import('reflect-metadata');
    await import('dotenv/config');
    const [
        {
            applyLightDefaultEnv,
            applyPackagedLightRuntimeSqliteDefaults,
            loadExistingHandyMasterSecret,
            resolveLightDataDir,
        },
        { applySqliteMigrationsFromEnvironment },
        { prepareServerSentryInstrumentation },
        { registerProcessHandlers },
    ] = await Promise.all([
        import('@/flavors/light/env'),
        import('@/flavors/light/sqliteMigrations'),
        import('@/app/monitoring/sentry'),
        import('@/utils/process/processHandlers'),
    ]);

    process.env.HAPPY_SERVER_FLAVOR = 'light';
    process.env.HAPPIER_SERVER_FLAVOR = 'light';

    const admitPersonalHomeMaintenance = async (
        action: 'ordinary' | 'attest' | 'materialize_endpoint',
    ): Promise<void> => {
        applyLightDefaultEnv(process.env);
        applyPackagedLightRuntimeSqliteDefaults(process.env);
        if (!isPersonalHomeRuntimePurpose(process.env.HAPPIER_MANAGED_RELAY_PURPOSE)) return;
        const { assertPersonalHomeBootAdmission, resolvePersonalHomeRuntimeLayout } = await import('@happier-dev/cli-common/firstPartyRuntime/server');
        const layout = resolvePersonalHomeRuntimeLayout({ env: process.env });
        if (action === 'ordinary') {
            await assertPersonalHomeBootAdmission(layout, {
                kind: 'ordinary',
                startupNonce: process.env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE,
            });
            return;
        }
        await assertPersonalHomeBootAdmission(layout, {
            kind: 'relocation-maintenance',
            operationId: String(process.env.HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID ?? '').trim(),
            action,
        });
    };

    if (argv.includes('--attest-personal-home-readiness')) {
        await admitPersonalHomeMaintenance('attest');
        await loadExistingHandyMasterSecret(process.env);
        const [
            { auth },
            { createPersonalHomeAuthenticatedReadiness },
            { initDbSqlite, shutdownDbClient },
        ] = await Promise.all([
            import('@/app/auth/auth'),
            import('@/app/runtime/personalHomeReadiness'),
            import('@/storage/db'),
        ]);
        await initDbSqlite();
        const readiness = await (async () => {
            await auth.init();
            return await createPersonalHomeAuthenticatedReadiness(process.env);
        })().finally(async () => {
            await shutdownDbClient();
        });
        if (!readiness) {
            throw new Error('Personal Home authenticated readiness requires an initialized Account');
        }
        process.stdout.write(`${JSON.stringify(readiness)}\n`);
        return;
    }

    if (argv.includes('--materialize-iroh-endpoint-descriptor')) {
        const sourceDescriptorRevision = readPositiveSafeIntegerArgument(
            argv,
            '--source-descriptor-revision',
        );
        if (sourceDescriptorRevision === null) {
            throw new Error('--materialize-iroh-endpoint-descriptor requires a positive --source-descriptor-revision');
        }
        await admitPersonalHomeMaintenance('materialize_endpoint');
        const [
            { materializeHomeIrohEndpointDescriptor },
            { createHomeConnectionDescriptorContinuityStoreForServer },
            { reserveRelocatedHomeConnectionDescriptor },
            { initDbSqlite, shutdownDbClient },
        ] = await Promise.all([
            import('@/app/iroh/homeIrohEndpoint'),
            import('@/app/features/homeConnectionDescriptorContinuity'),
            import('@/app/features/homeConnectionDescriptorPublication'),
            import('@/storage/db'),
        ]);
        await initDbSqlite();
        const result = await (async () => {
            const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(process.env);
            if (!continuityStore) {
                throw new Error('Personal Home descriptor continuity is unavailable');
            }
            const materialized = await materializeHomeIrohEndpointDescriptor({
                env: process.env,
                continuityStore,
            });
            if (materialized.status === 'failed') return materialized;
            const connectionDescriptor = await reserveRelocatedHomeConnectionDescriptor({
                env: process.env,
                continuityStore,
                minimumOuterRevisionExclusive: sourceDescriptorRevision,
                irohEndpoint: materialized.status === 'ready' ? materialized.endpoint : null,
            });
            return { status: 'ready', connectionDescriptor };
        })().finally(async () => {
            await shutdownDbClient();
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }

    const claimHomeOwner = readHomeOwnerClaimRequest(argv);
    if (claimHomeOwner) {
        // The claim needs the Home's database and nothing else: no auth module,
        // no master secret, no key material. It grants Home governance only, so
        // opening any of those would be unnecessary exposure for a command an
        // operator runs from a shell.
        await admitPersonalHomeMaintenance('ordinary');
        const { initDbSqlite, shutdownDbClient } = await import('@/storage/db');
        await initDbSqlite();
        const claim = await runHomeOwnerClaimCommand(claimHomeOwner).finally(async () => {
            await shutdownDbClient();
        });
        process.stdout.write(`${JSON.stringify(claim.output)}\n`);
        process.exitCode = claim.exitCode;
        return;
    }

    if (readPrintHomeClaimCodeRequest(argv)) {
        // Same needs and admission as the owner claim it enables: the Home's database only.
        await admitPersonalHomeMaintenance('ordinary');
        const { initDbSqlite, shutdownDbClient } = await import('@/storage/db');
        await initDbSqlite();
        const printed = await runPrintHomeClaimCodeCommand().finally(async () => {
            await shutdownDbClient();
        });
        process.stdout.write(`${JSON.stringify(printed.output)}\n`);
        process.exitCode = printed.exitCode;
        return;
    }

    if (argv.includes('--migrate-only')) {
        await admitPersonalHomeMaintenance('ordinary');
        await applySqliteMigrationsFromEnvironment({
            env: process.env,
            dataDir: resolveLightDataDir(process.env),
        });
        return;
    }

    // Instrument dependencies before runtime import; the post-overlay startup owner configures the client.
    prepareServerSentryInstrumentation();
    registerProcessHandlers();

    const { startServer } = await import('@/startServer');
    await startServer('light');
}
