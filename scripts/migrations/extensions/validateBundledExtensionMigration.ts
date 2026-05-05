import { type InventoryFile } from '../../testing/migrations/lib/migrationTypes.ts';

import { type ForbiddenExtensionUnificationFinding } from './extension-unification-move-map.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function collectForbiddenBundledExtensionMigrationFindings(
    files: readonly InventoryFile[],
): ForbiddenExtensionUnificationFinding[] {
    const findings: ForbiddenExtensionUnificationFinding[] = [];

    const shouldEnforceGeneratedAgentsFile = files.some((file) => file.filePath.startsWith('packages/'));
    if (shouldEnforceGeneratedAgentsFile) {
        const generatedAgentsFilePath = 'packages/agents/src/generated/bundledAgentDefinitions.ts';
        const legacyFamiliesFilePath = 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts';

        const generatedAgentsFileInInventory = files.find((file) => file.filePath === generatedAgentsFilePath) ?? null;
        const generatedAgentsFileAbsPath = resolve(process.cwd(), generatedAgentsFilePath);
        const generatedAgentsFileExistsOnDisk = existsSync(generatedAgentsFileAbsPath);

        const hasRequiredGeneratedAgentsFile = (
            generatedAgentsFileInInventory !== null
            // In scoped runs, file inventory may not include `packages/agents/**` even when we want to
            // enforce the contract. Allow the validator to observe the real filesystem in that case.
            || generatedAgentsFileExistsOnDisk
        );
        const hasForbiddenGeneratedAgentsFile = files.some((file) => (
            file.filePath === legacyFamiliesFilePath
        ));

        if (!hasRequiredGeneratedAgentsFile) {
            findings.push({
                filePath: generatedAgentsFilePath,
                pattern: 'missing required generated file',
                replacement: 'Generate bundled agent definitions map (no families naming)',
            });
        }

        const legacyFamiliesFileExistsOnDisk = existsSync(resolve(process.cwd(), legacyFamiliesFilePath));
        if (hasForbiddenGeneratedAgentsFile || legacyFamiliesFileExistsOnDisk) {
            findings.push({
                filePath: legacyFamiliesFilePath,
                pattern: legacyFamiliesFilePath,
                replacement: `Delete legacy generated file; use ${generatedAgentsFilePath}`,
            });
        }

        // When running scoped validations, the inventory may omit the generated agents file. Still enforce the
        // naming/export contract by reading it from disk when present.
        if (generatedAgentsFileInInventory === null && generatedAgentsFileExistsOnDisk) {
            try {
                const content = readFileSync(generatedAgentsFileAbsPath, 'utf8');
                const syntheticFile: InventoryFile = { filePath: generatedAgentsFilePath, content };

                const namingTruth = detectNoFamiliesNamingTruth(syntheticFile);
                if (namingTruth) {
                    findings.push(namingTruth);
                } else {
                    const required = detectRequiredNoFamiliesIdentifiersInGeneratedAgentsFile(syntheticFile);
                    if (required) {
                        findings.push(required);
                    }
                }
            } catch {
                // If the file exists but can't be read, surface a deterministic failure.
                findings.push({
                    filePath: generatedAgentsFilePath,
                    pattern: 'failed to read generated file',
                    replacement: 'Ensure packages/agents/src/generated/bundledAgentDefinitions.ts is readable',
                });
            }
        }
    }

    const flaggedFilePaths = new Set<string>();

    for (const file of files) {
        if (isMigrationAssetPath(file.filePath)) {
            continue;
        }
        if (file.filePath === 'packages/protocol/src/plugins/pluginManifestV1.ts') {
            findings.push({
                filePath: file.filePath,
                pattern: 'packages/protocol/src/plugins/pluginManifestV1.ts',
                replacement: 'Delete V1 manifest; use packages/protocol/src/plugins/manifest/v2.ts',
            });
            flaggedFilePaths.add(file.filePath);
            continue;
        }

        const uiLeftover = detectUiTsLeftover(file.filePath);
        if (uiLeftover) {
            findings.push(uiLeftover);
            flaggedFilePaths.add(file.filePath);
        }

        const forbiddenHostImport = detectForbiddenHostImportsInExtensionPackage(file);
        if (forbiddenHostImport) {
            findings.push(forbiddenHostImport);
            flaggedFilePaths.add(file.filePath);
        }
    }

    for (const file of files) {
        if (isMigrationAssetPath(file.filePath)) {
            continue;
        }
        if (flaggedFilePaths.has(file.filePath)) {
            continue;
        }

        const namingTruth = detectNoFamiliesNamingTruth(file);
        if (namingTruth) {
            findings.push(namingTruth);
            continue;
        }

        const requiredNamingTruth = detectRequiredNoFamiliesIdentifiersInGeneratedAgentsFile(file);
        if (requiredNamingTruth) {
            findings.push(requiredNamingTruth);
            continue;
        }

        const v1Tokens = detectV1ManifestToken(file);
        if (v1Tokens) {
            findings.push(v1Tokens);
            continue;
        }

        const archTruth = detectBuiltInPluginArchitecturalTruth(file);
        if (archTruth) {
            findings.push(archTruth);
        }
    }

    const migratedAgentIds = collectMigratedAgentIds(files);
    if (migratedAgentIds.size > 0) {
        for (const file of files) {
            if (isMigrationAssetPath(file.filePath)) {
                continue;
            }
            const hostLocalOwner = detectHostLocalOwnershipForMigratedAgent(file, migratedAgentIds);
            if (!hostLocalOwner) {
                continue;
            }

            if (isBridgeOnlyModule(file.content)) {
                continue;
            }

            findings.push(hostLocalOwner);
        }
    }

    return findings
        .filter((finding, index, all) => all.findIndex((other) => (
            other.filePath === finding.filePath
            && other.pattern === finding.pattern
        )) === index)
        .sort((left, right) => (
            left.filePath.localeCompare(right.filePath)
            || left.pattern.localeCompare(right.pattern)
        ));
}

function isMigrationAssetPath(filePath: string): boolean {
    return filePath.startsWith('scripts/migrations/');
}

function detectNoFamiliesNamingTruth(file: InventoryFile): ForbiddenExtensionUnificationFinding | null {
    const forbiddenTokens = [
        'AGENT_DEFINITION_FAMILY',
        'BUNDLED_AGENT_DEFINITION_FAMILY_IDS',
        'BUNDLED_AGENT_DEFINITION_FAMILIES_BY_ID',
        'bundledAgentDefinitionFamilies',
    ];

    for (const token of forbiddenTokens) {
        if (!file.content.includes(token)) {
            continue;
        }

        return {
            filePath: file.filePath,
            pattern: token,
            replacement: token === 'AGENT_DEFINITION_FAMILY'
                ? 'Rename to AGENT_DEFINITION'
                : token === 'BUNDLED_AGENT_DEFINITION_FAMILY_IDS'
                    ? 'Rename to BUNDLED_AGENT_DEFINITION_IDS'
                    : token === 'bundledAgentDefinitionFamilies'
                        ? 'Rename to bundledAgentDefinitions'
                        : 'Rename to BUNDLED_AGENT_DEFINITIONS_BY_ID',
        };
    }

    return null;
}

function detectRequiredNoFamiliesIdentifiersInGeneratedAgentsFile(file: InventoryFile): ForbiddenExtensionUnificationFinding | null {
    if (file.filePath !== 'packages/agents/src/generated/bundledAgentDefinitions.ts') {
        return null;
    }

    const hasRequiredExport = (
        /\bexport\s+(?:const|let|var)\s+bundledAgentDefinitions\b/u.test(file.content)
        || /\bexport\s+(?:const|let|var)\s+BUNDLED_AGENT_DEFINITIONS\b/u.test(file.content)
    );
    if (!hasRequiredExport) {
        return {
            filePath: file.filePath,
            pattern: 'missing required export: bundledAgentDefinitions',
            replacement: 'Export bundledAgentDefinitions (and/or BUNDLED_AGENT_DEFINITIONS) from generated output',
        };
    }

    return null;
}

function detectV1ManifestToken(file: InventoryFile): ForbiddenExtensionUnificationFinding | null {
    const forbiddenTokens = [
        'PluginManifestV1Schema',
        'PluginManifestV1',
        'toCanonicalPluginManifestFromV1',
        'CompatiblePluginManifest',
    ];

    for (const token of forbiddenTokens) {
        if (!file.content.includes(token)) {
            continue;
        }

        return {
            filePath: file.filePath,
            pattern: token,
            replacement: 'Remove V1 manifest parsing/conversion; use protocol V2 manifest schema and normalization',
        };
    }

    return null;
}

function detectUiTsLeftover(filePath: string): ForbiddenExtensionUnificationFinding | null {
    if (/^packages\/extensions\/[^/]+\/src\/ui\.ts$/u.test(filePath)) {
        return {
            filePath,
            pattern: 'packages/plugins/<extensionId>/src/ui.ts',
            replacement: 'Use packages/plugins/<extensionId>/src/ui/index.ts (ui folder) instead',
        };
    }

    if (/^packages\/extensions\/[^/]+\/src\/agent\/ui\.ts$/u.test(filePath)) {
        return {
            filePath,
            pattern: 'packages/plugins/<extensionId>/src/agent/ui.ts',
            replacement: 'Use packages/plugins/<extensionId>/src/agent/ui/** (folder) instead',
        };
    }

    if (/^apps\/ui\/sources\/agents\/providers\/[^/]+\/ui\.ts$/u.test(filePath)) {
        return {
            filePath,
            pattern: 'apps/ui/sources/agents/providers/<providerId>/ui.ts',
            replacement: 'Migrate UI contributions into packages/plugins/<extensionId>/src/ui/** (or bridge-only host-local export)',
        };
    }

    if (/^packages\/agents\/src\/providers\/[^/]+\/ui\.ts$/u.test(filePath)) {
        return {
            filePath,
            pattern: 'packages/agents/src/providers/<providerId>/ui.ts',
            replacement: 'Migrate UI contributions into packages/plugins/<extensionId>/src/agent/ui/** (or bridge-only host-local export)',
        };
    }

    return null;
}

function detectForbiddenHostImportsInExtensionPackage(file: InventoryFile): ForbiddenExtensionUnificationFinding | null {
    if (!file.filePath.startsWith('packages/plugins/')) {
        return null;
    }

    // Extensions must not import CLI host internals via `@/…` alias. This is the core boundary
    // that makes extensions extractable and disable-safe.
    if (/\bfrom\s+['"]@\//u.test(file.content) || /\brequire\s*\(\s*['"]@\//u.test(file.content)) {
        return {
            filePath: file.filePath,
            pattern: "from '@/…'",
            replacement: 'Extension packages must not import host internals; use injected ExtensionContextV1 services instead',
        };
    }

    // Also forbid direct `apps/**` imports from extension packages.
    if (/\bfrom\s+['"]apps\//u.test(file.content) || /\brequire\s*\(\s*['"]apps\//u.test(file.content)) {
        return {
            filePath: file.filePath,
            pattern: "from 'apps/…'",
            replacement: 'Extension packages must not import host apps; use shared packages or injected services instead',
        };
    }

    return null;
}

function isPluginSubstratePath(filePath: string): boolean {
    return (
        filePath.startsWith('apps/cli/src/plugins/')
        || filePath.startsWith('apps/ui/sources/agents/')
        || filePath.startsWith('apps/ui/sources/components/settings/plugins/')
        || filePath.startsWith('packages/protocol/src/plugins/')
    );
}

function isTestFilePath(filePath: string): boolean {
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath);
}

const ALLOWLISTED_BUILT_IN_PLUGIN_TRUTH_PATHS = new Set<string>([
    // Transitional plugin-substrate modules that still model legacy source kinds.
    // These are owned by the host-local substrate work and are intentionally not migrated yet.
    'apps/cli/src/plugins/registry/projection/v2.ts',
    'apps/cli/src/plugins/registry/resolveBuiltInContributions.ts',
    'apps/cli/src/plugins/registry/types.ts',
]);

function detectBuiltInPluginArchitecturalTruth(file: InventoryFile): ForbiddenExtensionUnificationFinding | null {
    if (!isPluginSubstratePath(file.filePath)) {
        return null;
    }

    if (isTestFilePath(file.filePath)) {
        return null;
    }

    if (ALLOWLISTED_BUILT_IN_PLUGIN_TRUTH_PATHS.has(file.filePath)) {
        return null;
    }

    const builtInPluginUnion = /['"]built_in['"]\s*\|\s*['"]plugin['"]/u;
    if (builtInPluginUnion.test(file.content)) {
        return {
            filePath: file.filePath,
            pattern: "'built_in' | 'plugin'",
            replacement: "Replace built_in|plugin split with provenance ('first_party'|'external') + source.kind",
        };
    }

    const builtInLiteral = /['"]built_in['"]/u;
    if (builtInLiteral.test(file.content)) {
        return {
            filePath: file.filePath,
            pattern: "'built_in'",
            replacement: "Replace built_in with provenance ('first_party') + source.kind ('bundled')",
        };
    }

    const builtInCamel = /['"]builtIn['"]/u;
    if (builtInCamel.test(file.content)) {
        return {
            filePath: file.filePath,
            pattern: "'builtIn'",
            replacement: "Replace builtIn with provenance ('first_party') + source.kind ('bundled')",
        };
    }

    // Only flag 'plugin' when it appears to be used as an architectural source-kind value.
    const pluginSourceKind = /\b(?:kind|sourceKind)\s*:\s*['"]plugin['"]/u;
    if (pluginSourceKind.test(file.content)) {
        return {
            filePath: file.filePath,
            pattern: "kind: 'plugin'",
            replacement: "Replace plugin source-kind with provenance ('external') + source.kind ('path'|'archive'|...)",
        };
    }

    return null;
}

function collectMigratedAgentIds(files: readonly InventoryFile[]): ReadonlySet<string> {
    const migratedAgentIds = new Set<string>();
    for (const file of files) {
        const match = /^packages\/extensions\/([^/]+)\/src\/agent\/definition\.ts$/u.exec(file.filePath);
        if (match) {
            migratedAgentIds.add(match[1]);
        }
    }
    return migratedAgentIds;
}

function detectHostLocalOwnershipForMigratedAgent(
    file: InventoryFile,
    migratedAgentIds: ReadonlySet<string>,
): ForbiddenExtensionUnificationFinding | null {
    const uiMatch = /^apps\/ui\/sources\/agents\/providers\/([^/]+)\//u.exec(file.filePath);
    if (uiMatch && migratedAgentIds.has(uiMatch[1])) {
        return {
            filePath: file.filePath,
            pattern: `dual-ownership: apps/ui/sources/agents/providers/${uiMatch[1]}/**`,
            replacement: `Migrate authored ownership into packages/plugins/${uiMatch[1]}/**; host-local tree must be bridge-only or deleted`,
        };
    }

    const agentsMatch = /^packages\/agents\/src\/providers\/([^/]+)\//u.exec(file.filePath);
    if (agentsMatch && migratedAgentIds.has(agentsMatch[1])) {
        return {
            filePath: file.filePath,
            pattern: `dual-ownership: packages/agents/src/providers/${agentsMatch[1]}/**`,
            replacement: `Migrate authored ownership into packages/plugins/${agentsMatch[1]}/**; host-local tree must be bridge-only or deleted`,
        };
    }

    const cliMatch = /^apps\/cli\/src\/backends\/([^/]+)\//u.exec(file.filePath);
    if (cliMatch && migratedAgentIds.has(cliMatch[1])) {
        return {
            filePath: file.filePath,
            pattern: `dual-ownership: apps/cli/src/backends/${cliMatch[1]}/**`,
            replacement: `Migrate authored ownership into packages/plugins/${cliMatch[1]}/**; host-local tree must be bridge-only or deleted`,
        };
    }

    return null;
}

function stripLineComments(content: string): string[] {
    const lines: string[] = [];
    let inBlockComment = false;

    for (const rawLine of content.split('\n')) {
        let line = rawLine;

        if (inBlockComment) {
            const end = line.indexOf('*/');
            if (end === -1) {
                continue;
            }
            line = line.slice(end + 2);
            inBlockComment = false;
        }

        while (true) {
            const start = line.indexOf('/*');
            if (start === -1) {
                break;
            }
            const end = line.indexOf('*/', start + 2);
            if (end === -1) {
                line = line.slice(0, start);
                inBlockComment = true;
                break;
            }
            line = `${line.slice(0, start)}${line.slice(end + 2)}`;
        }

        const commentStart = line.indexOf('//');
        if (commentStart !== -1) {
            line = line.slice(0, commentStart);
        }

        const trimmed = line.trim();
        if (trimmed.length > 0) {
            lines.push(trimmed);
        }
    }

    return lines;
}

function isBridgeOnlyModule(content: string): boolean {
    const lines = stripLineComments(content);
    if (lines.length === 0) {
        return true;
    }

    for (const line of lines) {
        if (/^export\s+\*\s+from\s+['"].+['"]\s*;?$/u.test(line)) {
            continue;
        }
        if (/^export\s+type\s+\*\s+from\s+['"].+['"]\s*;?$/u.test(line)) {
            continue;
        }
        if (/^export\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"].+['"]\s*;?$/u.test(line)) {
            continue;
        }
        if (/^export\s+(?:type\s+)?\{[^}]*\}\s*;?$/u.test(line)) {
            // Allow re-export of locally-imported type-only exports in bridge files, but keep it narrow.
            // This still fails if the file contains non-export statements.
            continue;
        }
        return false;
    }

    return true;
}

// No side effects on import. Tests live in `validateBundledExtensionMigration.test.ts`.
