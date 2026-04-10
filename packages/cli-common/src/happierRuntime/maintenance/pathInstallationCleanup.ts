import type { HappierInstallation, HappierInstallationInventory, HappierService } from '../types.js';
import { resolvePreferredHappierCliInstallation } from '../installations/resolvePreferredHappierCliInstallation.js';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '../runtimePathMatching.js';
import {
    buildCliUninstallPlan,
    resolveManualUninstallCommandForSource,
    type CliUninstallPlan,
    type UnsupportedInstallSource,
} from './cliUninstall.js';

type HappierCliShimName = 'happier' | 'hprev' | 'hdev';

export type PathInstallationCleanupAction =
    | Readonly<{
        kind: 'uninstall-installation';
        shimName: HappierCliShimName;
        installation: HappierInstallation;
        uninstallPlan: Extract<CliUninstallPlan, { kind: 'managed-installation' | 'npm-global-installation' }>;
        previewCommand: string;
    }>
    | Readonly<{
        kind: 'manual-installation-cleanup';
        shimName: HappierCliShimName;
        installation: HappierInstallation;
        source: UnsupportedInstallSource;
        previewCommand: string;
    }>;

export type PathInstallationCleanupPlan = Readonly<{
    preservedInstallations: ReadonlyArray<Readonly<{
        shimName: HappierCliShimName;
        installation: HappierInstallation;
    }>>;
    actions: readonly PathInstallationCleanupAction[];
}>;

const HAPPIER_CLI_SHIMS: readonly HappierCliShimName[] = ['happier', 'hprev', 'hdev'] as const;

function resolveCanonicalCliInstallation(params: Readonly<{
    inventory: HappierInstallationInventory;
    installation: HappierInstallation;
}>): HappierInstallation {
    const candidateRuntimePath = normalizeHappierRuntimePath(params.installation.realPath ?? params.installation.path);
    if (!candidateRuntimePath) {
        return params.installation;
    }
    return params.inventory.installations.find((entry) => {
        if (entry.id === params.installation.id) {
            return false;
        }
        if (!entry.components.includes('happier-cli')) {
            return false;
        }
        const roots = [entry.path, entry.realPath]
            .map(normalizeHappierRuntimePath)
            .filter((value): value is string => Boolean(value));
        return roots.some((root) => isHappierRuntimePathWithinRoot(candidateRuntimePath, root));
    }) ?? params.installation;
}

function resolvePreviewCommand(
    plan: Extract<CliUninstallPlan, { kind: 'managed-installation' | 'npm-global-installation' }>,
): string {
    return plan.kind === 'npm-global-installation'
        ? [plan.command.cmd, ...plan.command.args].join(' ')
        : `uninstall Happier CLI at ${plan.installation.path}`;
}

function buildActionsForShim(params: Readonly<{
    shimName: HappierCliShimName;
    inventory: HappierInstallationInventory;
    services: readonly HappierService[];
    keepService: boolean;
}>): PathInstallationCleanupPlan {
    const onPathCandidates = params.inventory.installations
        .filter((entry) => (
            entry.onPath
            && entry.components.includes('happier-cli')
            && entry.shimName === params.shimName
        ));
    if (onPathCandidates.length <= 1) {
        return {
            preservedInstallations: [],
            actions: [],
        };
    }

    const preferredInstallation = resolvePreferredHappierCliInstallation({
        inventory: params.inventory,
        preferredCliCommand: params.shimName,
    });
    const preservedInstallation = preferredInstallation
        ? resolveCanonicalCliInstallation({
            inventory: params.inventory,
            installation: preferredInstallation,
        })
        : resolveCanonicalCliInstallation({
            inventory: params.inventory,
            installation: onPathCandidates[0]!,
        });

    const seenInstallationIds = new Set<string>([preservedInstallation.id]);
    const actions: PathInstallationCleanupAction[] = [];
    for (const candidate of onPathCandidates) {
        const canonicalInstallation = resolveCanonicalCliInstallation({
            inventory: params.inventory,
            installation: candidate,
        });
        if (seenInstallationIds.has(canonicalInstallation.id)) {
            continue;
        }
        seenInstallationIds.add(canonicalInstallation.id);
        const uninstallPlan = buildCliUninstallPlan({
            selectedInstallation: canonicalInstallation,
            services: params.services,
            keepService: params.keepService,
        });
        if (uninstallPlan.kind === 'managed-installation' || uninstallPlan.kind === 'npm-global-installation') {
            actions.push({
                kind: 'uninstall-installation',
                shimName: params.shimName,
                installation: canonicalInstallation,
                uninstallPlan,
                previewCommand: resolvePreviewCommand(uninstallPlan),
            });
            continue;
        }
        const source = uninstallPlan.kind === 'unsupported-install-source' ? uninstallPlan.source : 'unknown';
        actions.push({
            kind: 'manual-installation-cleanup',
            shimName: params.shimName,
            installation: canonicalInstallation,
            source,
            previewCommand: resolveManualUninstallCommandForSource(source),
        });
    }

    return {
        preservedInstallations: [{
            shimName: params.shimName,
            installation: preservedInstallation,
        }],
        actions,
    };
}

export function buildPathInstallationCleanupPlan(params: Readonly<{
    inventory: HappierInstallationInventory;
    services: readonly HappierService[];
    keepService: boolean;
}>): PathInstallationCleanupPlan {
    const preservedInstallations: Array<{ shimName: HappierCliShimName; installation: HappierInstallation }> = [];
    const actions: PathInstallationCleanupAction[] = [];
    const seenActionInstallations = new Set<string>();
    for (const shimName of HAPPIER_CLI_SHIMS) {
        const plan = buildActionsForShim({
            shimName,
            inventory: params.inventory,
            services: params.services,
            keepService: params.keepService,
        });
        preservedInstallations.push(...plan.preservedInstallations);
        for (const action of plan.actions) {
            if (seenActionInstallations.has(action.installation.id)) {
                continue;
            }
            seenActionInstallations.add(action.installation.id);
            actions.push(action);
        }
    }
    return {
        preservedInstallations,
        actions,
    };
}
