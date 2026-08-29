import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { acquirePersonalHomeOperationLock, normalizePersonalHomeLockOrder } from './lock.js';

export type PersonalHomeBundleTransfer = Readonly<{
    send(input: Readonly<{
        sourcePath: string;
        expectedBytes: number;
        expectedSha256: string;
        destination: unknown;
    }>): Promise<Readonly<{
        receivedPath: string;
        bytes: number;
        sha256: string;
    }>>;
}>;

export type PersonalHomeRelocationPhase = 'staged' | 'verified' | 'pending' | 'committed';

export type PersonalHomeRelocationMarker = Readonly<{
    version: 1;
    phase: PersonalHomeRelocationPhase;
    sourceDataDir: string;
    destinationDataDir: string;
    homeServerIdentityId: string;
    bundleSha256: string;
    priorSourceRunning: boolean;
}>;

export type PersonalHomeRelocationResult = Readonly<{
    homeServerIdentityId: string;
    destinationVerified: boolean;
    sourceStopped: boolean;
    sourceRollbackPath?: string;
    locationUpdateRequired: boolean;
    publicIntegrationsNeedAttention: string[];
    followerAction: 'none' | 'reconnect' | 'reenroll';
}>;

function markerPath(dataDir: string): string {
    return join(resolve(dataDir), '.operations', 'relocation.json');
}

async function writeMarker(dataDir: string, marker: PersonalHomeRelocationMarker): Promise<void> {
    const path = markerPath(dataDir);
    await mkdir(join(resolve(dataDir), '.operations'), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}

function verifyTransfer(params: Readonly<{
    expectedBytes: number;
    expectedSha256: string;
    actual: Readonly<{ bytes: number; sha256: string }>;
}>): void {
    if (params.actual.bytes !== params.expectedBytes || params.actual.sha256 !== params.expectedSha256) {
        throw new Error('Personal Home bundle transfer verification failed');
    }
}

/**
 * Owns the data cutover only. Carrier choice and directory/profile publication remain injected
 * seams, so this owner never creates another transfer protocol or location authority.
 */
export async function relocatePersonalHome(params: Readonly<{
    source: Readonly<{ dataDir: string; homeServerIdentityId: string }>;
    destination: Readonly<{ dataDir: string }>;
    createFinalBackup(): Promise<Readonly<{ path: string; sha256: string; manifest: unknown }>>;
    prepareDestination(): Promise<void>;
    stopSource(): Promise<void>;
    transfer: PersonalHomeBundleTransfer;
    restoreDestination(receivedPath: string): Promise<void>;
    verifyDestination(): Promise<Readonly<{ homeServerIdentityId: string }>>;
    startDestination(): Promise<void>;
    stopDestination?(): Promise<void>;
    commitSameHomeRelocation(input: Readonly<{ homeId: string; newConnectionDescriptor: unknown }>): Promise<void>;
    destinationDescriptor: unknown;
    priorSourceRunning?: boolean;
    quarantineDestination?(): Promise<void>;
    publicIntegrationsNeedAttention?: readonly string[];
    followerAction?: 'none' | 'reconnect' | 'reenroll';
}>): Promise<PersonalHomeRelocationResult> {
    const sourceDataDir = resolve(params.source.dataDir);
    const destinationDataDir = resolve(params.destination.dataDir);
    if (sourceDataDir === destinationDataDir) throw new Error('Personal Home relocation source and destination must differ');
    const orderedDataDirs = normalizePersonalHomeLockOrder([sourceDataDir, destinationDataDir]);
    const releases: Array<() => Promise<void>> = [];
    let bundleSha256 = '';
    let sourceStopped = false;
    let committed = false;
    let destinationStarted = false;
    let destinationStopped = false;
    let destinationQuarantined = false;

    const persist = async (phase: PersonalHomeRelocationPhase): Promise<void> => {
        const marker: PersonalHomeRelocationMarker = {
            version: 1,
            phase,
            sourceDataDir,
            destinationDataDir,
            homeServerIdentityId: params.source.homeServerIdentityId,
            bundleSha256,
            priorSourceRunning: params.priorSourceRunning ?? true,
        };
        await writeMarker(sourceDataDir, marker);
        await writeMarker(destinationDataDir, marker);
    };

    try {
        for (const dataDir of orderedDataDirs) releases.push(await acquirePersonalHomeOperationLock(dataDir, 'relocate'));
        await params.prepareDestination();
        await persist('staged');

        await params.stopSource();
        sourceStopped = true;
        const backup = await params.createFinalBackup();
        const expectedBytes = (await stat(backup.path)).size;
        bundleSha256 = backup.sha256;
        const received = await params.transfer.send({
            sourcePath: backup.path,
            expectedBytes,
            expectedSha256: backup.sha256,
            destination: { dataDir: destinationDataDir },
        });
        verifyTransfer({ expectedBytes, expectedSha256: backup.sha256, actual: received });
        await params.restoreDestination(received.receivedPath);
        const verified = await params.verifyDestination();
        if (verified.homeServerIdentityId !== params.source.homeServerIdentityId) {
            throw new Error('Restored Personal Home identity does not match source Home');
        }
        await persist('verified');
        await params.startDestination();
        destinationStarted = true;

        try {
            await params.commitSameHomeRelocation({
                homeId: params.source.homeServerIdentityId,
                newConnectionDescriptor: params.destinationDescriptor,
            });
        } catch (error) {
            if (destinationStarted && !destinationStopped) {
                await params.stopDestination?.().catch(() => undefined);
                destinationStopped = true;
            }
            await persist('pending');
            if (!destinationQuarantined) {
                await params.quarantineDestination?.();
                destinationQuarantined = true;
            }
            throw error;
        }
        committed = true;
        await persist('committed');
        return {
            homeServerIdentityId: params.source.homeServerIdentityId,
            destinationVerified: true,
            sourceStopped: true,
            sourceRollbackPath: sourceDataDir,
            locationUpdateRequired: false,
            publicIntegrationsNeedAttention: [...(params.publicIntegrationsNeedAttention ?? [])],
            followerAction: params.followerAction ?? 'reconnect',
        };
    } catch (error) {
        if (sourceStopped && !committed) {
            if (destinationStarted && !destinationStopped) {
                await params.stopDestination?.().catch(() => undefined);
                destinationStopped = true;
            }
            await persist('pending').catch(() => undefined);
            if (!destinationQuarantined) {
                await params.quarantineDestination?.().catch(() => undefined);
                destinationQuarantined = true;
            }
        }
        throw error;
    } finally {
        for (const release of releases.reverse()) await release();
    }
}

export async function readPersonalHomeRelocationMarker(dataDir: string): Promise<PersonalHomeRelocationMarker | null> {
    try {
        const { readFile } = await import('node:fs/promises');
        const parsed = JSON.parse(await readFile(markerPath(dataDir), 'utf8')) as Partial<PersonalHomeRelocationMarker>;
        if (
            parsed.version !== 1
            || !['staged', 'verified', 'pending', 'committed'].includes(String(parsed.phase))
            || typeof parsed.sourceDataDir !== 'string'
            || typeof parsed.destinationDataDir !== 'string'
            || typeof parsed.homeServerIdentityId !== 'string'
            || typeof parsed.bundleSha256 !== 'string'
            || typeof parsed.priorSourceRunning !== 'boolean'
        ) return null;
        return parsed as PersonalHomeRelocationMarker;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
