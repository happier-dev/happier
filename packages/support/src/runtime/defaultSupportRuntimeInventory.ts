import { happierRuntime as cliHappierRuntime } from '@happier-dev/cli-common';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
    SupportInstallationEntry,
    SupportRuntimeInventory,
    SupportRuntimeTargetEntry,
    SupportServiceEntry,
    SupportWarning,
} from '../types.js';
type HappierInstallation = cliHappierRuntime.HappierInstallation;
type HappierServiceRuntimeTarget = cliHappierRuntime.HappierServiceRuntimeTarget;
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

async function resolveRealPathSafe(path: string): Promise<string | null> {
    try {
        return await realpath(path);
    } catch {
        return null;
    }
}

async function resolveInvokedSupportVersion(input: Readonly<{
    explicitVersion: string | null;
    invokedBinaryPath: string;
}>): Promise<string | null> {
    const explicitVersion = String(input.explicitVersion ?? '').trim();
    if (explicitVersion) {
        return explicitVersion;
    }

    const resolvedBinaryPath = await resolveRealPathSafe(input.invokedBinaryPath);
    return (
        await findNearestPackageVersion(resolvedBinaryPath ?? '')
        ?? await findNearestPackageVersion(input.invokedBinaryPath)
    );
}

function buildInstallationLabel(entry: HappierInstallation): string {
    if (entry.components.includes('hstack')) return 'Happier Stack';
    if (entry.components.includes('happier-server')) return 'Happier Server';
    return entry.source === 'npmGlobal' ? 'Happier CLI (npm)' : 'Happier CLI';
}

function buildServiceLabel(entry: HappierService): string {
    if (entry.serviceType === 'stack-service') return `Stack service: ${entry.label}`;
    if (entry.serviceType === 'self-host-service') return `Self-host service: ${entry.label}`;
    return `Daemon service: ${entry.label}`;
}

function mapInstallation(entry: HappierInstallation): SupportInstallationEntry {
    return {
        id: entry.id,
        label: buildInstallationLabel(entry),
        kind: 'installation',
        path: entry.path,
        realPath: entry.realPath,
        version: entry.version,
        ring: entry.ring,
        status: entry.onPath ? 'on-path' : 'installed',
        shimName: entry.shimName,
        source: entry.source,
    };
}

function mapRuntimeTarget(
    target: HappierServiceRuntimeTarget,
    linkedServices: readonly HappierService[],
): SupportRuntimeTargetEntry {
    return {
        id: target.id,
        label: target.label,
        kind: 'runtime-target',
        category: target.kind,
        path: target.path,
        executablePath: target.executablePath,
        linkedServiceIds: linkedServices.map((service) => service.id),
        linkedServiceLabels: linkedServices.map((service) => buildServiceLabel(service)),
    };
}

function mapService(
    entry: HappierService,
    runtimeTarget: HappierServiceRuntimeTarget | null,
): SupportServiceEntry {
    return {
        id: entry.id,
        label: buildServiceLabel(entry),
        kind: entry.serviceType,
        targetMode: entry.targetMode ?? null,
        path: entry.definitionPath,
        executablePath: entry.executablePath,
        linkedInstallationId: runtimeTarget?.kind === 'installation' ? runtimeTarget.installationId : null,
        linkedInstallationPath: runtimeTarget?.kind === 'installation' ? runtimeTarget.installationPath : null,
        linkedRuntimeTargetId: runtimeTarget && runtimeTarget.kind !== 'installation' ? runtimeTarget.id : null,
        linkedRuntimeTargetLabel: runtimeTarget && runtimeTarget.kind !== 'installation' ? runtimeTarget.label : null,
        linkedRuntimeTargetPath: runtimeTarget && runtimeTarget.kind !== 'installation' ? runtimeTarget.path : null,
        linkedRuntimeTargetCategory: runtimeTarget && runtimeTarget.kind !== 'installation' ? runtimeTarget.kind : null,
        version: null,
        ring: entry.ring,
        status: entry.running ? 'running' : entry.installed ? 'installed' : 'missing',
        scope: entry.scope,
        serverUrl: entry.serverUrl ?? null,
        publicServerUrl: entry.publicServerUrl ?? null,
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
    const resolvedServiceTargets = services.services.map((service) => ({
        service,
        runtimeTarget: cliHappierRuntime.resolveHappierServiceRuntimeTarget({
            service,
            installations: installations.installations,
        }),
    }));
    const additionalRuntimeServices = new Map<string, {
        target: HappierServiceRuntimeTarget;
        services: HappierService[];
    }>();

    for (const entry of resolvedServiceTargets) {
        if (!entry.runtimeTarget || entry.runtimeTarget.kind === 'installation') {
            continue;
        }
        const existing = additionalRuntimeServices.get(entry.runtimeTarget.id);
        if (existing) {
            existing.services.push(entry.service);
            continue;
        }
        additionalRuntimeServices.set(entry.runtimeTarget.id, {
            target: entry.runtimeTarget,
            services: [entry.service],
        });
    }

    return {
        invokedBinaryPath,
        invokedVersion: await resolveInvokedSupportVersion({
            explicitVersion: String(input.packageVersion ?? processEnv.npm_package_version ?? '').trim() || null,
            invokedBinaryPath,
        }),
        nodeVersion: String(input.nodeVersion ?? process.version),
        platform,
        installations: installations.installations.map(mapInstallation),
        services: resolvedServiceTargets.map((entry) => mapService(entry.service, entry.runtimeTarget)),
        runtimeTargets: [...additionalRuntimeServices.values()].map((entry) => mapRuntimeTarget(entry.target, entry.services)),
        warnings: warnings.map(mapWarning),
    };
}
