import { ApiClient } from '@/api/api';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { MachineMetadata } from '@/api/types';
import { startCaffeinate } from '@/integrations/caffeinate';
import { acquireDaemonLock } from '@/persistence';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';

import { getPreferredHostName } from '../machine/metadata';
import { stopDaemon, isDaemonRunningCurrentlyInstalledHappyVersion } from '../controlClient';
import type { DaemonStartupSource } from '../ownership/daemonOwnershipMetadata';
import { configuration } from '@/configuration';
import {
    readOrCreateDeviceLocalSecretStorage,
    type DeviceLocalSecretStorage,
} from '../deviceLocalSecretStorage';

export async function prepareDaemonBootstrapContext(
    params: Readonly<{
        daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>>;
        initialMachineMetadata: MachineMetadata;
        startupSource: DaemonStartupSource;
    }>,
): Promise<Readonly<{
    daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>>;
    credentials: Awaited<ReturnType<typeof authAndSetupMachineIfNeeded>>['credentials'];
    api: Awaited<ReturnType<typeof ApiClient.create>>;
    preferredHost: string;
    metadataForRegistration: MachineMetadata;
    preflightMachineRegistration: Awaited<ReturnType<typeof ensureMachineRegistered>> | null;
    machineId: string;
    deviceLocalSecretStorage: DeviceLocalSecretStorage;
}>> {
    const auth = await authAndSetupMachineIfNeeded();
    const credentials = auth.credentials;
    let machineId = auth.machineId;
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

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
            logger.debug('[DAEMON RUN] Daemon version or machine identity mismatch detected, restarting daemon with current CLI version');
            await stopDaemon();
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

    const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
        path: configuration.deviceLocalSecretKeyFile,
    });
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

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
