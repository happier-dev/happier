import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveYarnCommandInvocation } from '../workspaces/execYarnCommand.mjs';

import {
  buildPluginWorkspaceTestInvocations,
  discoverPluginWorkspaceTestPackageReport,
  type PluginWorkspaceScriptName,
  type PluginWorkspaceTestInvocation,
  type PluginWorkspaceTestPackageReport,
} from './lib/pluginWorkspaceTestPackages.ts';

export interface RunPluginWorkspaceTestsOptions {
  rootDir?: string;
  scriptName?: PluginWorkspaceScriptName;
  discoverReport?: (rootDir: string) => Promise<PluginWorkspaceTestPackageReport>;
  runInvocation?: (invocation: PluginWorkspaceTestInvocation) => Promise<void>;
}

function formatDiscoveryFailure(
  report: PluginWorkspaceTestPackageReport,
  scriptName: PluginWorkspaceScriptName,
): Error {
  return new Error(`Plugin workspace ${scriptName} selection failed:\n${report.issues.map((issue) => `- ${issue}`).join('\n')}`);
}

function formatTestFailures(
  failures: readonly { invocation: PluginWorkspaceTestInvocation; error: unknown }[],
  scriptName: PluginWorkspaceScriptName,
): Error {
  return new Error([
    `Plugin workspace ${scriptName} failures:`,
    ...failures.map(({ invocation, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return `- ${invocation.packageName}: ${message}`;
    }),
  ].join('\n'));
}

async function runYarnWorkspaceScript(
  invocation: PluginWorkspaceTestInvocation,
  rootDir: string,
  scriptName: PluginWorkspaceScriptName,
): Promise<void> {
  const yarn = resolveYarnCommandInvocation([...invocation.args], {
    npmExecPath: process.env.npm_execpath,
  });
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(yarn.command, [...yarn.args], {
      cwd: rootDir,
      stdio: 'inherit',
      ...(yarn.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`Plugin workspace ${scriptName} ${invocation.packageName} terminated with signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`Plugin workspace ${scriptName} ${invocation.packageName} exited with status ${code ?? 1}.`));
        return;
      }
      resolveRun();
    });
  });
}

export async function runPluginWorkspaceTests(
  options: RunPluginWorkspaceTestsOptions = {},
): Promise<readonly PluginWorkspaceTestInvocation[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const scriptName = options.scriptName ?? 'test';
  const report = await (options.discoverReport ?? discoverPluginWorkspaceTestPackageReport)(rootDir);
  if (report.issues.length > 0) {
    throw formatDiscoveryFailure(report, scriptName);
  }

  const invocations = buildPluginWorkspaceTestInvocations(report.packages, scriptName);
  if (invocations.length === 0) {
    throw new Error(`Plugin workspace ${scriptName} selection failed: no executable plugin workspace packages were selected.`);
  }

  const runInvocation = options.runInvocation
    ?? ((invocation: PluginWorkspaceTestInvocation) => runYarnWorkspaceScript(invocation, rootDir, scriptName));
  const failures: { invocation: PluginWorkspaceTestInvocation; error: unknown }[] = [];
  for (const invocation of invocations) {
    try {
      await runInvocation(invocation);
    } catch (error) {
      failures.push({ invocation, error });
    }
  }
  if (failures.length > 0) {
    throw formatTestFailures(failures, scriptName);
  }
  return invocations;
}

async function main(): Promise<void> {
  const scriptName = process.argv[2];
  if (scriptName !== undefined && scriptName !== 'typecheck') {
    throw new Error(`Unsupported plugin workspace script ${scriptName}.`);
  }
  await runPluginWorkspaceTests({ scriptName });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
