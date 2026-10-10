import { readHomeOwnerClaimRequest, readPrintHomeClaimCodeRequest } from '@/app/home/governance/claimHomeOwnerCommand';
import { prepareServerSentryInstrumentation } from '@/app/monitoring/sentry';
import { registerProcessHandlers } from '@/utils/process/processHandlers';

/**
 * The full server entrypoint.
 *
 * Ordinary invocation starts the server. A deployment-local operator command is
 * recognized here and handed to the same `startServer` composition, which runs
 * it once the database provider is resolved and then returns without opening
 * listeners. There is no separate operator binary, command framework, or
 * bootstrap secret: authority to run this comes from process access to the
 * deployment itself.
 */
export async function runFullServerMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = 'full';
    process.env.HAPPIER_SERVER_FLAVOR = 'full';

    const claimHomeOwner = readHomeOwnerClaimRequest(argv);
    const printHomeClaimCode = !claimHomeOwner && readPrintHomeClaimCodeRequest(argv);

    // Instrument dependencies before runtime import; the post-overlay startup owner configures the client.
    prepareServerSentryInstrumentation();
    registerProcessHandlers();

    const { startServer } = await import('@/startServer');
    await startServer('full', claimHomeOwner
        ? { claimHomeOwner }
        : printHomeClaimCode ? { printHomeClaimCode: true } : undefined);
}
