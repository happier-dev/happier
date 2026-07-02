import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
    const explicitConfigDir = readString(env.CLAUDE_CONFIG_DIR);
    const homeDir = resolveHomeDir(env);
    const configuredConfigDir = readString(env.HAPPIER_CLAUDE_CONFIG_DIR) ?? join(homeDir, '.claude');
    return dedupeRootConfigPathCandidates([
        ...(explicitConfigDir ? [{
            rootDir: explicitConfigDir,
            path: join(explicitConfigDir, '.claude.json'),
        }] : []),
        {
            rootDir: homeDir,
            path: join(homeDir, '.claude.json'),
        },
        {
            rootDir: configuredConfigDir,
            path: join(configuredConfigDir, '.claude.json'),
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
        // An explicit decline on the override candidate is authoritative: do not
        // fall through to ambient home/default config dirs.
        if (result.hasExplicitTrustState && index === 0 && readString(params.sourceEnv.CLAUDE_CONFIG_DIR)) {
            return null;
        }
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
 * Projects an already-accepted workspace-trust decision for the session directory
 * from the user's source Claude root config (`.claude.json`) into a materialized
 * connected-service home.
 *
 * Without this, Claude spawned into a freshly materialized `CLAUDE_CONFIG_DIR`
 * re-prompts the interactive workspace-trust dialog for workspaces the user
 * already trusted — which hangs remote/headless sessions. Only the trust
 * projection (`hasTrustDialogAccepted` plus the project-onboarding marker) is
 * carried; no other project config and no account identity is copied into the
 * materialized home.
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
    if (!projection) return;
    const existingRoot = await readClaudeRootConfigFile(join(params.targetDir, '.claude.json')) ?? {};
    const existingProjects = readObject(existingRoot.projects) ?? {};
    await writeClaudeRootConfig({
        targetDir: params.targetDir,
        rootConfig: {
            ...existingRoot,
            projects: {
                ...existingProjects,
                [sessionDirectory]: projection,
            },
        },
    });
}
