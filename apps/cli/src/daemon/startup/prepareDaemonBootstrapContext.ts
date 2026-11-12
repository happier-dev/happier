import { join } from 'node:path';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { ApiClient } from '@/api/api';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { MachineMetadata } from '@/api/types';
import { acquireDaemonLock, readStoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { authAndPrepareDaemonMachineIfNeeded } from '@/ui/auth';

import { getPreferredHostName } from '../machine/metadata';
import {
    inspectDaemonRunningStateAndCleanupStaleState,
    isDaemonRunningCurrentlyInstalledHappyVersion,
    stopDaemon,
} from '../controlClient';
import type { DaemonStartupSource } from '../ownership/daemonOwnershipMetadata';
import { configuration } from '@/configuration';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { runApprovalStartupPasses } from '@/session/actions/approvals/startupPasses';
import {
    readOrCreateDeviceLocalSecretStorage,
    type DeviceLocalSecretStorage,
} from '../deviceLocalSecretStorage';

export async function prepareDaemonBootstrapContext(
    params: Readonly<{
        daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>>;
        initialMachineMetadata: MachineMetadata;
        startupSource: DaemonStartupSource;
        prepareServerTransport?: (input: Readonly<{
            persistedCredentials: Awaited<ReturnType<typeof readStoredCredentials>>;
        }>) => Promise<void>;
        verifyServerTransport?: (input: Readonly<{
            credentials: Awaited<ReturnType<typeof authAndPrepareDaemonMachineIfNeeded>>['credentials'];
        }>) => Promise<void>;
    }>,
): Promise<Readonly<{
    daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>>;
    credentials: Awaited<ReturnType<typeof authAndPrepareDaemonMachineIfNeeded>>['credentials'];
    api: Awaited<ReturnType<typeof ApiClient.create>>;
    preferredHost: string;
    metadataForRegistration: MachineMetadata;
    preflightMachineRegistration: Awaited<ReturnType<typeof ensureMachineRegistered>> | null;
    machineId: string;
    deviceLocalSecretStorage: DeviceLocalSecretStorage;
}>> {
    const persistedCredentials = await readStoredCredentials();
    await params.prepareServerTransport?.({ persistedCredentials });

    const auth = await authAndPrepareDaemonMachineIfNeeded();
    const credentials = auth.credentials;
    let machineId = auth.machineId;
    logger.debug('[DAEMON RUN] Auth and local machine identity preparation complete');

    await params.verifyServerTransport?.({ credentials });
    const api = await ApiClient.create(credentials);
    const preferredHost = await getPreferredHostName();
    const metadataForRegistration: MachineMetadata = { ...params.initialMachineMetadata, host: preferredHost };
    let preflightMachineRegistration: Awaited<ReturnType<typeof ensureMachineRegistered>> | null = null;

    const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion({
        expectedMachineId: machineId,
    });
    if (runningDaemonVersionMatches && params.startupSource === 'self-restart') {
        logger.debug('[DAEMON RUN] Self-restart replacement detected matching daemon; skipping synchronous machine preflight and continuing takeover');
    } else if (!runningDaemonVersionMatches) {
        if (params.daemonLockHandle) {
            logger.debug('[DAEMON RUN] Daemon startup already owns the lock; continuing without asking the control client to stop its own pre-state process');
        } else {
            const incumbent = await inspectDaemonRunningStateAndCleanupStaleState();
            if (incumbent.status === 'not-running') {
                logger.debug('[DAEMON RUN] Persisted daemon state has no live process; acquiring startup ownership without a stop attempt');
            } else {
                logger.debug('[DAEMON RUN] Daemon version or machine identity mismatch detected, restarting daemon with current CLI version');
                await stopDaemon();
            }
        }
    } else {
        preflightMachineRegistration = await ensureMachineRegistered({
            api,
            machineId,
            metadata: metadataForRegistration,
            caller: 'startDaemon preflight',
        });
        machineId = preflightMachineRegistration.machineId;
        if (preflightMachineRegistration.didRotateMachineId) {
            logger.debug('[DAEMON RUN] Same-version daemon matched a stale machine id, restarting daemon with recovered machine identity');
            await stopDaemon();
            preflightMachineRegistration = null;
        } else {
            logger.debug('[DAEMON RUN] Daemon version and machine identity match, keeping existing daemon');
            console.log('Daemon already running with matching version');
            process.exit(0);
        }
    }

    let daemonLockHandle = params.daemonLockHandle;
    if (!daemonLockHandle) {
        daemonLockHandle = await acquireDaemonLock(5, 200);
    }
    if (!daemonLockHandle) {
        logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
        process.exit(0);
    }

    // Session creation uses this daemon-wide client before the child has a
    // Session socket. Publish the final (including recovered) machine identity
    // so getOrCreateSession can establish its AccessKey binding before launch.
    api.setLocalMachineId(machineId);

    const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
        path: configuration.deviceLocalSecretKeyFile,
    });

    // Exclusive startup ownership proves this Machine's previous in-process
    // executions are gone. Settle their claims before any ingress can claim new work.
    const approvalsStore = createCliApprovalsArtifactStore({ credentials });
    try {
        const recovery = await approvalsStore.approvalsRecoverExecuting({ machineId });
        if (recovery.settled || recovery.failed || recovery.coverage !== 'complete') {
            logger.debug('[DAEMON RUN] Action approval startup recovery', recovery);
        }
    } catch {
        logger.debug('[DAEMON RUN] Action approval startup recovery unavailable', {
            code: 'approval_recovery_unavailable',
        });
    }

    // One-time approval owner passes; never blocks startup and reports on default log paths.
    const approvalAccountId = readAccountIdFromToken(credentials.token);
    void runApprovalStartupPasses(approvalsStore, approvalAccountId ? {
        settlementPath: join(configuration.activeServerDir, 'approval-startup-passes', `${encodeURIComponent(approvalAccountId)}.json`),
    } : undefined);

    return {
        daemonLockHandle,
        credentials,
        api,
        preferredHost,
        metadataForRegistration,
        preflightMachineRegistration,
        machineId,
        deviceLocalSecretStorage,
    };
}
