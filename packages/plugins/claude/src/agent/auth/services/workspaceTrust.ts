import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveClaudeConfigDir } from '../../environment.js';

type JsonObject = Record<string, unknown>;

type ClaudeWorkspaceTrustProjection = Readonly<{
    hasTrustDialogAccepted: true;
    hasCompletedProjectOnboarding?: true;
}>;

type ClaudeRootConfigPathCandidate = Readonly<{
    rootDir: string;
    path: string;
}>;

function readObject(value: unknown): JsonObject | null {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function readClaudeRootConfigFile(path: string): Promise<JsonObject | null> {
    try {
        return readObject(JSON.parse(await readFile(path, 'utf8')));
    } catch {
        return null;
    }
}

function dedupeRootConfigPathCandidates(
    candidates: readonly ClaudeRootConfigPathCandidate[],
): ClaudeRootConfigPathCandidate[] {
    const seen = new Set<string>();
    const result: ClaudeRootConfigPathCandidate[] = [];
    for (const candidate of candidates) {
        const key = resolve(candidate.path);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
    return readString(env.HOME) ?? readString(env.USERPROFILE) ?? homedir();
}

function resolveClaudeRootConfigPathCandidates(env: NodeJS.ProcessEnv): ClaudeRootConfigPathCandidate[] {
    const configuredConfigDir = resolveClaudeConfigDir(env);
    const homeDir = resolveHomeDir(env);
    return dedupeRootConfigPathCandidates([
        {
            rootDir: configuredConfigDir,
            path: join(configuredConfigDir, '.claude.json'),
        },
        {
            rootDir: homeDir,
            path: join(homeDir, '.claude.json'),
        },
    ]);
}

function readProjectTrustProjection(
    rootConfig: JsonObject,
    sessionDirectory: string,
): Readonly<{ hasExplicitTrustState: boolean; projection: ClaudeWorkspaceTrustProjection | null }> {
    const projectConfig = readObject(readObject(rootConfig.projects)?.[sessionDirectory]);
    if (!projectConfig || typeof projectConfig.hasTrustDialogAccepted !== 'boolean') {
        return { hasExplicitTrustState: false, projection: null };
    }
    if (projectConfig.hasTrustDialogAccepted !== true) {
        return { hasExplicitTrustState: true, projection: null };
    }
    return {
        hasExplicitTrustState: true,
        projection: {
            hasTrustDialogAccepted: true,
            ...(projectConfig.hasCompletedProjectOnboarding === true ? { hasCompletedProjectOnboarding: true } : {}),
        },
    };
}

async function resolveWorkspaceTrustProjection(params: Readonly<{
    sourceEnv: NodeJS.ProcessEnv;
    sessionDirectory: string;
    targetDir: string;
}>): Promise<ClaudeWorkspaceTrustProjection | null> {
    const targetRoot = resolve(params.targetDir);
    const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
        .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
    for (let index = 0; index < candidates.length; index += 1) {
        const rootConfig = await readClaudeRootConfigFile(candidates[index].path);
        if (!rootConfig) continue;
        const result = readProjectTrustProjection(rootConfig, params.sessionDirectory);
        if (result.projection) return result.projection;
        // An explicit decline is authoritative: do not default trust or fall
        // through to ambient home/default config dirs.
        if (result.hasExplicitTrustState) {
            return null;
        }
    }
    return null;
}

async function resolveClaudeCompletedOnboardingProjection(params: Readonly<{
    sourceEnv: NodeJS.ProcessEnv;
    targetDir: string;
}>): Promise<true | null> {
    const targetRoot = resolve(params.targetDir);
    const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
        .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
    for (const candidate of candidates) {
        const rootConfig = await readClaudeRootConfigFile(candidate.path);
        if (!rootConfig || typeof rootConfig.hasCompletedOnboarding !== 'boolean') continue;
        return rootConfig.hasCompletedOnboarding === true ? true : null;
    }
    return null;
}

async function writeClaudeRootConfig(params: Readonly<{
    targetDir: string;
    rootConfig: JsonObject;
}>): Promise<void> {
    await mkdir(params.targetDir, { recursive: true });
    const targetPath = join(params.targetDir, '.claude.json');
    const tempPath = join(params.targetDir, `.claude.${randomUUID()}.tmp`);
    try {
        await writeFile(tempPath, `${JSON.stringify(params.rootConfig)}\n`, { mode: 0o600 });
        if (process.platform !== 'win32') {
            await chmod(tempPath, 0o600);
        }
        await rename(tempPath, targetPath);
        if (process.platform !== 'win32') {
            await chmod(targetPath, 0o600);
        }
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

/**
 * Projects the workspace-trust decision for the session directory into a
 * materialized connected-service home.
 *
 * Only an explicit accepted source decision is projected. Missing or declined
 * trust remains owned by Claude's normal Trust/Exit flow. The project trust
 * projection and the exact non-secret top-level onboarding-completion boolean
 * are resolved independently, so onboarding can be carried without synthesizing
 * workspace trust. No other project config or account identity is copied from
 * the source into the materialized home.
 */
export async function projectClaudeWorkspaceTrust(params: Readonly<{
    sourceEnv: NodeJS.ProcessEnv;
    targetDir: string;
    sessionDirectory?: string | null;
}>): Promise<void> {
    const sessionDirectory = readString(params.sessionDirectory) ? resolve(readString(params.sessionDirectory)!) : null;
    if (!sessionDirectory) return;

    const projection = await resolveWorkspaceTrustProjection({
        sourceEnv: params.sourceEnv,
        sessionDirectory,
        targetDir: params.targetDir,
    });
    const hasCompletedOnboarding = await resolveClaudeCompletedOnboardingProjection({
        sourceEnv: params.sourceEnv,
        targetDir: params.targetDir,
    });
    if (!projection && !hasCompletedOnboarding) return;

    const existingRoot = await readClaudeRootConfigFile(join(params.targetDir, '.claude.json')) ?? {};
    const existingProjects = projection ? (readObject(existingRoot.projects) ?? {}) : null;
    const existingProjectEntry = projection && existingProjects
        ? (readObject(existingProjects[sessionDirectory]) ?? {})
        : null;
    await writeClaudeRootConfig({
        targetDir: params.targetDir,
        rootConfig: {
            ...existingRoot,
            ...(hasCompletedOnboarding ? { hasCompletedOnboarding } : {}),
            ...(projection && existingProjects && existingProjectEntry
                ? {
                    projects: {
                        ...existingProjects,
                        [sessionDirectory]: {
                            ...existingProjectEntry,
                            ...projection,
                        },
                    },
                }
                : {}),
        },
    });
}

const CLAUDE_ACCOUNT_SCOPED_ROOT_KEYS = [
    'oauthAccount',
    'modelAccessCache',
    'additionalModelOptionsCache',
    'cachedExtraUsageDisabledReason',
] as const;

export async function reconcileClaudeAccountScopedRootConfig(params: Readonly<{
    targetDir: string;
    preserveExistingAccountState: boolean;
    providerAccountId: string | null;
    providerEmail: string | null;
}>): Promise<void> {
    // This owner is invoked only after exact native credential materialization succeeds.
    // Provider onboarding readiness is distinct from workspace trust, which remains unsynthesized.
    const existingRoot = await readClaudeRootConfigFile(join(params.targetDir, '.claude.json')) ?? {};
    const next: JsonObject = {
        ...existingRoot,
        hasCompletedOnboarding: true,
    };
    if (!params.preserveExistingAccountState) {
        for (const key of CLAUDE_ACCOUNT_SCOPED_ROOT_KEYS) delete next[key];
    }
    const oauthAccount = {
        ...(params.providerAccountId ? { accountUuid: params.providerAccountId } : {}),
        ...(params.providerEmail ? { emailAddress: params.providerEmail } : {}),
    };
    await writeClaudeRootConfig({
        targetDir: params.targetDir,
        rootConfig: !params.preserveExistingAccountState && Object.keys(oauthAccount).length > 0
            ? { ...next, oauthAccount }
            : next,
    });
}
