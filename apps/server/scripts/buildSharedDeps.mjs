import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerRepoRoot } from './resolveServerRepoRoot.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveServerRepoRoot({ startDir: __dirname, existsSync });
const tscInvocation = resolveTypeScriptCliInvocation({ repoRoot, processExecPath: process.execPath });

function runTsc(tsconfigPath) {
  execFileSync(tscInvocation.command, [...tscInvocation.argsPrefix, '-p', tsconfigPath], { stdio: 'inherit' });
}

// Build shared packages (dist/ is the runtime contract).
// Protocol must build first because agents consumes @happier-dev/protocol dist/types.
runTsc(resolve(repoRoot, 'packages', 'protocol', 'tsconfig.json'));
runTsc(resolve(repoRoot, 'packages', 'agents', 'tsconfig.json'));
// Server imports shared runtime helpers from cli-common (e.g. tailscale helpers).
runTsc(resolve(repoRoot, 'packages', 'cli-common', 'tsconfig.json'));

// Sanity check: ensure protocol dist entry exists.
const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
if (!existsSync(protocolDist)) {
  throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
}

// Sanity check: ensure cli-common dist entry exists for server runtime imports.
const cliCommonTailscaleDist = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'tailscale', 'index.js');
if (!existsSync(cliCommonTailscaleDist)) {
  throw new Error(`Expected @happier-dev/cli-common tailscale build output missing: ${cliCommonTailscaleDist}`);
}
