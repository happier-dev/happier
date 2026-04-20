import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PrismaCliEntrypointState = "healthy" | "missing" | "recursive_shell_wrapper";

type EnsurePrismaCliReadyParams = Readonly<{
    serverRoot: string;
    entryPath?: string;
    env?: NodeJS.ProcessEnv;
    quiet?: boolean;
    fileExists?: (path: string) => Promise<boolean>;
    readText?: (path: string) => Promise<string>;
    installFn?: (params: Readonly<{ repoRoot: string; env: NodeJS.ProcessEnv; quiet: boolean }>) => Promise<void>;
}>;

type RunPrismaCliParams = Readonly<{
    serverRoot: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    quiet?: boolean;
}>;

export function resolveServerWorkspaceRoot(importMetaUrl: string): string {
    return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

function uniquePaths(values: string[]): string[] {
    return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function prependPathEntry(currentPath: string | undefined, entries: string[]): string {
    const delimiter = process.platform === "win32" ? ";" : ":";
    const current = String(currentPath ?? "")
        .split(delimiter)
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);
    return [...uniquePaths(entries), ...current.filter((value) => !entries.includes(value))].join(delimiter);
}

export function buildPrismaCliEnv(params: Readonly<{ serverRoot: string; env?: NodeJS.ProcessEnv }>): NodeJS.ProcessEnv {
    const serverRoot = resolve(params.serverRoot);
    const repoRoot = resolve(serverRoot, "..", "..");
    const env: NodeJS.ProcessEnv = { ...(params.env ?? process.env) };
    const pathEntries = [
        resolve(serverRoot, "node_modules", ".bin"),
        resolve(repoRoot, "node_modules", ".bin"),
    ];
    env.PATH = prependPathEntry(env.PATH, pathEntries);
    return env;
}

export function classifyPrismaCliEntrypointSource(params: Readonly<{ entryPath: string; source: string }>): PrismaCliEntrypointState {
    const entryPath = resolve(params.entryPath);
    const source = String(params.source ?? "");
    if (!source.trim()) {
        return "missing";
    }
    const lines = source.split(/\r?\n/);
    const firstLine = lines[0] ?? "";
    if (/^#!.*\bnode(?:\s|$)/i.test(firstLine) || !firstLine.startsWith("#!")) {
        return "healthy";
    }
    if (/^#!\/bin\/sh\b/.test(firstLine)) {
        const execLine = lines[1] ?? "";
        const match = execLine.match(/exec\s+"[^"]+"\s+"([^"]+)"/);
        if (match?.[1] && resolve(match[1]) === entryPath) {
            return "recursive_shell_wrapper";
        }
    }
    return "healthy";
}

function defaultFileExists(path: string): Promise<boolean> {
    return Promise.resolve(existsSync(path));
}

async function readPrismaCliEntrypointState(params: Readonly<{
    entryPath: string;
    fileExists: (path: string) => Promise<boolean>;
    readText: (path: string) => Promise<string>;
}>): Promise<PrismaCliEntrypointState> {
    const exists = await params.fileExists(params.entryPath);
    if (!exists) {
        return "missing";
    }
    const source = await params.readText(params.entryPath);
    return classifyPrismaCliEntrypointSource({ entryPath: params.entryPath, source });
}

function run(command: string, args: string[], options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; quiet: boolean }>): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env as Record<string, string>,
            stdio: options.quiet ? "ignore" : "inherit",
            shell: false,
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolvePromise();
                return;
            }
            reject(new Error(`${command} exited with code ${code}`));
        });
    });
}

function resolvePrismaCliEntrypoint(serverRoot: string): string {
    const req = createRequire(resolve(serverRoot, "package.json"));
    return req.resolve("prisma/build/index.js");
}

async function defaultInstallFn(params: Readonly<{ repoRoot: string; env: NodeJS.ProcessEnv; quiet: boolean }>): Promise<void> {
    await run("yarn", ["install", "--force", "--ignore-scripts", "--production=false"], {
        cwd: params.repoRoot,
        env: params.env,
        quiet: params.quiet,
    });
}

export async function ensurePrismaCliReady(params: EnsurePrismaCliReadyParams): Promise<Readonly<{ entryPath: string; repaired: boolean }>> {
    const serverRoot = resolve(params.serverRoot);
    const repoRoot = resolve(serverRoot, "..", "..");
    const entryPath = resolve(params.entryPath ?? resolvePrismaCliEntrypoint(serverRoot));
    const env = { ...(params.env ?? process.env) };
    const quiet = Boolean(params.quiet);
    const fileExists = params.fileExists ?? defaultFileExists;
    const readText = params.readText ?? ((path: string) => readFile(path, "utf8"));
    const installFn = params.installFn ?? defaultInstallFn;

    const initialState = await readPrismaCliEntrypointState({ entryPath, fileExists, readText });
    if (initialState === "healthy") {
        return { entryPath, repaired: false };
    }

    await installFn({ repoRoot, env, quiet });

    const repairedState = await readPrismaCliEntrypointState({ entryPath, fileExists, readText });
    if (repairedState !== "healthy") {
        throw new Error(
            `[prisma-cli] Prisma CLI entrypoint is unusable after repair attempt (${repairedState}): ${entryPath}`,
        );
    }
    return { entryPath, repaired: true };
}

export async function runPrismaCli(params: RunPrismaCliParams): Promise<void> {
    const env = buildPrismaCliEnv({ serverRoot: params.serverRoot, env: params.env });
    const { entryPath } = await ensurePrismaCliReady({
        serverRoot: params.serverRoot,
        env,
        quiet: params.quiet,
    });
    await run(process.execPath, [entryPath, ...params.args], {
        cwd: params.serverRoot,
        env,
        quiet: Boolean(params.quiet),
    });
}
