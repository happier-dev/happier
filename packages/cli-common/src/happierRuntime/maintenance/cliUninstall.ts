import { spawnSync } from 'node:child_process';

import { uninstallManagedFirstPartyComponent, type UninstallManagedFirstPartyComponentResult } from '../../firstPartyRuntime/index.js';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
    isHappierRuntimePathWithinRoot,
    normalizeHappierRuntimePath,
} from '../runtimePathMatching.js';
import type { HappierInstallation, HappierService } from '../types.js';
import { uninstallHappierService } from './uninstallHappierService.js';

export type UnsupportedInstallSource = 'fromSource' | 'npmGlobal' | 'pathBinary' | 'unknown';

export type CliUninstallPlan =
    | Readonly<{
        kind: 'managed-installation';
        installation: HappierInstallation;
        channel: PublicReleaseRingId;
        serviceTargets: readonly HappierService[];
    }>
    | Readonly<{
        kind: 'npm-global-installation';
        installation: HappierInstallation;
        command: Readonly<{ cmd: string; args: readonly string[] }>;
        serviceTargets: readonly HappierService[];
    }>
    | Readonly<{
        kind: 'unsupported-install-source';
        source: UnsupportedInstallSource;
        manualCommands: readonly string[];
    }>
    | Readonly<{
        kind: 'active-installation-not-found';
    }>;

export type CliUninstallResult = Readonly<{
    removedPaths: readonly string[];
    serviceTargets: ReadonlyArray<Readonly<{ id: string; label: string }>>;
    actions?: ReadonlyArray<Readonly<{ command: string; reason: string }>>;
}> & Pick<UninstallManagedFirstPartyComponentResult, 'removedPaths'>;

export function cliUninstallPlanRequiresRoot(params: Readonly<{
    plan: Extract<CliUninstallPlan, { kind: 'managed-installation' | 'npm-global-installation' }>;
    uid: number | null;
}>): boolean {
    return params.uid !== null
        && params.uid !== 0
        && params.plan.serviceTargets.some((service) => service.scope === 'system');
}

function resolveManagedCliChannel(ring: string | null | undefined): PublicReleaseRingId {
    return normalizePublicReleaseRingId(String(ring ?? '').trim()) || 'stable';
}

export function parseUnsupportedInstallSourceFromInstallationId(
    installationId: string | null | undefined,
): UnsupportedInstallSource | null {
    const prefix = String(installationId ?? '').split(':', 1)[0]?.trim() ?? '';
    if (prefix === 'fromSource' || prefix === 'npmGlobal' || prefix === 'pathBinary' || prefix === 'unknown') {
        return prefix;
    }
    return null;
}

function resolveUnsupportedInstallSource(source: string | null | undefined): UnsupportedInstallSource {
    return source === 'npmGlobal' || source === 'fromSource' || source === 'pathBinary'
        ? source
        : 'unknown';
}

export function resolveManualUninstallCommandForSource(source: UnsupportedInstallSource): string {
    return source === 'npmGlobal'
        ? 'npm uninstall -g @happier-dev/cli'
        : 'Remove the binary or checkout manually, then run `happier service list --json` to inspect leftover services.';
}

function resolveMatchingDaemonServices(
    services: readonly HappierService[],
    installationRoots: readonly string[],
): HappierService[] {
    return services.filter((service) => {
        if (service.serviceType !== 'daemon' || service.verification !== 'verified') return false;
        const executablePath = normalizeHappierRuntimePath(service.executablePath);
        if (!executablePath) return false;
        return installationRoots.some((root) => isHappierRuntimePathWithinRoot(executablePath, root));
    });
}

export function buildCliUninstallPlan(params: Readonly<{
    selectedInstallation: HappierInstallation | null;
    inferredUnsupportedSource?: UnsupportedInstallSource | null;
    services: readonly HappierService[];
    keepService: boolean;
}>): CliUninstallPlan {
    const selectedInstallation = params.selectedInstallation;
    if (!selectedInstallation) {
        if (params.inferredUnsupportedSource) {
            return {
                kind: 'unsupported-install-source',
                source: params.inferredUnsupportedSource,
                manualCommands: [resolveManualUninstallCommandForSource(params.inferredUnsupportedSource)],
            };
        }
        return { kind: 'active-installation-not-found' };
    }

    const installationRoots = [selectedInstallation.path, selectedInstallation.realPath]
        .map(normalizeHappierRuntimePath)
        .filter((value): value is string => Boolean(value));
    const serviceTargets = params.keepService ? [] : resolveMatchingDaemonServices(params.services, installationRoots);

    if (selectedInstallation.source === 'firstPartyManaged') {
        return {
            kind: 'managed-installation',
            installation: selectedInstallation,
            channel: resolveManagedCliChannel(selectedInstallation.ring),
            serviceTargets,
        };
    }

    if (
        selectedInstallation.source === 'npmGlobal'
        && (
            selectedInstallation.packageManager?.kind === 'npmGlobal'
            || selectedInstallation.components.includes('happier-cli')
        )
    ) {
        const packageManager = selectedInstallation.packageManager ?? null;
        const packageName = packageManager?.packageName
            ?? (selectedInstallation.components.includes('happier-cli') ? '@happier-dev/cli' : null);
        if (!packageName) {
            return {
                kind: 'unsupported-install-source',
                source: 'npmGlobal',
                manualCommands: [resolveManualUninstallCommandForSource('npmGlobal')],
            };
        }
        return {
            kind: 'npm-global-installation',
            installation: selectedInstallation,
            command: {
                cmd: packageManager?.executablePath || 'npm',
                args: ['uninstall', '-g', packageName],
            },
            serviceTargets,
        };
    }

    const unsupportedSource = resolveUnsupportedInstallSource(selectedInstallation.source);
    return {
        kind: 'unsupported-install-source',
        source: unsupportedSource,
        manualCommands: [resolveManualUninstallCommandForSource(unsupportedSource)],
    };
}

async function uninstallServiceTargets(serviceTargets: readonly HappierService[]): Promise<void> {
    for (const service of serviceTargets) {
        await uninstallHappierService({
            platform: service.platform,
            backend: service.backend,
            scope: service.scope,
            label: service.label,
            definitionPath: service.definitionPath,
            runCommands: true,
        });
    }
}

function runCommand(input: Readonly<{ cmd: string; args: readonly string[]; processEnv?: NodeJS.ProcessEnv }>): void {
    const result = spawnSync(input.cmd, [...input.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: input.processEnv ?? process.env,
        encoding: 'utf8',
    });
    if (result.error) {
        throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
        const detail = `${String(result.stderr ?? '')}${String(result.stdout ?? '')}`.trim();
        throw new Error(detail || `Command failed: ${input.cmd} ${input.args.join(' ')}`.trim());
    }
}

export async function applyCliUninstallPlan(params: Readonly<{
    plan: Extract<CliUninstallPlan, { kind: 'managed-installation' | 'npm-global-installation' }>;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<CliUninstallResult> {
    await uninstallServiceTargets(params.plan.serviceTargets);

    if (params.plan.kind === 'managed-installation') {
        const result = await uninstallManagedFirstPartyComponent({
            componentId: 'happier-cli',
            channel: params.plan.channel,
            processEnv: params.processEnv,
        });
        return {
            removedPaths: result.removedPaths,
            serviceTargets: params.plan.serviceTargets.map((service) => ({
                id: service.id,
                label: service.label,
            })),
        };
    }

    runCommand({
        ...params.plan.command,
        processEnv: params.processEnv,
    });
    return {
        removedPaths: [params.plan.installation.path],
        serviceTargets: params.plan.serviceTargets.map((service) => ({
            id: service.id,
            label: service.label,
        })),
        actions: [{
            command: [params.plan.command.cmd, ...params.plan.command.args].join(' '),
            reason: 'npm-global-installation',
        }],
    };
}
