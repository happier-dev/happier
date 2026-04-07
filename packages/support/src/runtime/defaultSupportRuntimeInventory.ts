import { happierRuntime as cliHappierRuntime } from '@happier-dev/cli-common';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SupportInventoryEntry, SupportRuntimeInventory, SupportWarning } from '../types.js';
type HappierInstallation = cliHappierRuntime.HappierInstallation;
type HappierRuntimeWarning = cliHappierRuntime.HappierRuntimeWarning;
type HappierService = cliHappierRuntime.HappierService;

async function readJsonVersion(packageJsonPath: string): Promise<string | null> {
    try {
        const raw = await readFile(packageJsonPath, 'utf8');
        const parsed = JSON.parse(String(raw)) as { version?: unknown };
        const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
        return version || null;
    } catch {
        return null;
    }
}

async function findNearestPackageVersion(startPath: string): Promise<string | null> {
    let currentDir = dirname(startPath);
    for (let depth = 0; depth < 8; depth += 1) {
        const version = await readJsonVersion(join(currentDir, 'package.json'));
        if (version) {
            return version;
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }
    return null;
}

function buildInstallationLabel(entry: HappierInstallation): string {
    if (entry.components.includes('hstack')) return 'Happier Stack';
    if (entry.components.includes('happier-server')) return 'Happier Server';
    return entry.source === 'npmGlobal' ? 'Happier CLI (npm)' : 'Happier CLI';
}

function buildServiceLabel(entry: HappierService): string {
    return entry.serviceType === 'stack-service' ? `Stack service: ${entry.label}` : `Daemon service: ${entry.label}`;
}

function mapInstallation(entry: HappierInstallation): SupportInventoryEntry {
    return {
        id: entry.id,
        label: buildInstallationLabel(entry),
        kind: 'installation',
        path: entry.path,
        version: entry.version,
        ring: entry.ring,
        status: entry.onPath ? 'on-path' : 'installed',
    };
}

function mapService(entry: HappierService): SupportInventoryEntry {
    return {
        id: entry.id,
        label: buildServiceLabel(entry),
        kind: entry.serviceType,
        path: entry.definitionPath,
        version: null,
        ring: entry.ring,
        status: entry.running ? 'running' : entry.installed ? 'installed' : 'missing',
    };
}

function mapWarning(entry: HappierRuntimeWarning): SupportWarning {
    return {
        code: entry.code,
        title: entry.message,
        severity: entry.severity,
        details: entry.repairCommands,
    };
}

export async function defaultSupportRuntimeInventory(input: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    argv?: readonly string[];
    execPath?: string;
    nodeVersion?: string;
    platform?: string;
    packageVersion?: string | null;
}> = {}): Promise<SupportRuntimeInventory> {
    const processEnv = input.processEnv ?? process.env;
    const argv = input.argv ?? process.argv;
    const invokedBinaryPath = String(argv[1] ?? input.execPath ?? process.execPath).trim() || process.execPath;
    const platform = String(input.platform ?? process.platform).trim() || process.platform;
    const installations = await cliHappierRuntime.discoverHappierInstallations({
        processEnv,
        invokedPath: null,
        invokerName: null,
    });
    const services = await cliHappierRuntime.discoverHappierServices({
        processEnv,
        platform: platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : undefined,
    });
    const warnings = cliHappierRuntime.buildHappierRuntimeWarnings({ installations, services });

    return {
        invokedBinaryPath,
        invokedVersion:
            String(input.packageVersion ?? processEnv.npm_package_version ?? '').trim()
            || await findNearestPackageVersion(invokedBinaryPath),
        nodeVersion: String(input.nodeVersion ?? process.version),
        platform,
        installations: installations.installations.map(mapInstallation),
        services: services.services.map(mapService),
        warnings: warnings.map(mapWarning),
    };
}
