import { spawn } from 'node:child_process';

import { isStressComposeProjectName } from './composeOwnership';

export type ComposeImageMetadata = Readonly<{
  createdAt?: string;
  labels: Record<string, string>;
}>;

export type ComposeRuntime = Readonly<{
  imageExists: (imageName: string) => Promise<boolean>;
  inspectImage: (imageName: string) => Promise<ComposeImageMetadata | null>;
  buildServerImage: (
    imageName: string,
    options?: {
      labels?: Record<string, string>;
      dockerfilePath?: string;
      contextDir?: string;
    },
  ) => Promise<void>;
  listOwnedProjects: () => Promise<string[]>;
  projectHasRunningContainers: (composeProjectName: string) => Promise<boolean>;
  removeProjectResources: (composeProjectName: string) => Promise<void>;
  up: (params: { apiReplicas: number; workerReplicas: number }) => Promise<void>;
  down: () => Promise<void>;
  restart: (service: string) => Promise<void>;
  start?: (service: string) => Promise<void>;
  stop?: (service: string) => Promise<void>;
  stopContainer?: (containerId: string) => Promise<void>;
  killContainer?: (containerId: string) => Promise<void>;
  ps: () => Promise<string>;
  logs: () => Promise<string>;
  serviceContainerIds: (service: string) => Promise<string[]>;
  inspectContainers: (containerIds: readonly string[]) => Promise<unknown[]>;
  execCapture: (service: string, command: readonly string[]) => Promise<string>;
}>;

function appendWithLimit(target: string, chunk: Buffer | string, limit: number): string {
  const next = target + chunk.toString();
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

async function runDocker(
  args: readonly string[],
  cwd: string,
  options: Readonly<{
    captureStdout?: boolean;
    attempts?: number;
  }> = {},
): Promise<string> {
  const captureStdout = options.captureStdout ?? true;
  const attempts = options.attempts ?? 3;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await new Promise((resolvePromise, reject) => {
        const child = spawn('docker', [...args], {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stdoutTail = '';
        let stderrTail = '';

        child.stdout?.on('data', (chunk: Buffer | string) => {
          if (captureStdout) {
            stdout += chunk.toString();
          } else {
            stdoutTail = appendWithLimit(stdoutTail, chunk, 8_192);
          }
        });

        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderrTail = appendWithLimit(stderrTail, chunk, 16_384);
        });

        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code === 0) {
            resolvePromise(stdout.trim());
            return;
          }

          const output = [stderrTail.trim(), stdoutTail.trim()].filter(Boolean).join('\n');
          const detail = output ? `\n${output}` : '';
          reject(
            new Error(
              `docker ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}${detail}`,
            ),
          );
        });
      });
    } catch (error) {
      if (attempt >= attempts || !isTransientDockerFailure(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }

  throw new Error(`docker ${args.join(' ')} failed after ${attempts} attempts`);
}

function isTransientDockerFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = typeof (error as Error & { code?: unknown }).code === 'string'
    ? (error as Error & { code?: string }).code?.toLowerCase()
    : undefined;
  const message = error.message.toLowerCase();
  return (
    code === 'ebadf'
    || message.includes('spawn ebadf')
    ||
    message.includes('500 internal server error for api route and version')
    || message.includes('check if the server supports the requested api version')
  );
}

function parseNonEmptyLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function listDockerResourceIds(args: readonly string[], cwd: string): Promise<string[]> {
  return parseNonEmptyLines(await runDocker(args, cwd));
}

export function createComposeRuntime(params: {
  composeFilePath: string;
  composeProjectName: string;
  cwd: string;
}): ComposeRuntime {
  const composeArgs = (...args: readonly string[]) => [
    'compose',
    '-f',
    params.composeFilePath,
    '-p',
    params.composeProjectName,
    ...args,
  ];

  return {
    imageExists: async (imageName) => {
      try {
        await runDocker(['image', 'inspect', imageName], params.cwd);
        return true;
      } catch {
        return false;
      }
    },
    inspectImage: async (imageName) => {
      try {
        const output = await runDocker(['image', 'inspect', imageName], params.cwd);
        const [entry] = JSON.parse(output) as Array<{
          Created?: string;
          Config?: {
            Labels?: Record<string, string>;
          };
        }>;
        if (!entry) return null;
        return {
          createdAt: entry.Created,
          labels: entry.Config?.Labels ?? {},
        };
      } catch {
        return null;
      }
    },
    buildServerImage: async (imageName, options = {}) => {
      const labelArgs = Object.entries(options.labels ?? {}).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
      const dockerfilePath = options.dockerfilePath ?? 'Dockerfile';
      const contextDir = options.contextDir ?? '.';
      await runDocker(
        [
          'build',
          '-f',
          dockerfilePath,
          '--target',
          'server-stress',
          ...labelArgs,
          '-t',
          imageName,
          contextDir,
        ],
        params.cwd,
        { captureStdout: false },
      );
    },
    listOwnedProjects: async () => {
      const projectNames = new Set<string>();
      const outputs = await Promise.all([
        runDocker(['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'], params.cwd),
        runDocker(['network', 'ls', '--format', '{{.Label "com.docker.compose.project"}}'], params.cwd),
        runDocker(['volume', 'ls', '--format', '{{.Label "com.docker.compose.project"}}'], params.cwd),
      ]);

      for (const output of outputs) {
        for (const projectName of parseNonEmptyLines(output)) {
          if (isStressComposeProjectName(projectName)) {
            projectNames.add(projectName);
          }
        }
      }

      return [...projectNames].sort((left, right) => left.localeCompare(right));
    },
    projectHasRunningContainers: async (composeProjectName) => {
      const runningContainerIds = await listDockerResourceIds(
        ['ps', '--filter', `label=com.docker.compose.project=${composeProjectName}`, '-q'],
        params.cwd,
      );
      return runningContainerIds.length > 0;
    },
    removeProjectResources: async (composeProjectName) => {
      const containerIds = await listDockerResourceIds(
        ['ps', '-a', '--filter', `label=com.docker.compose.project=${composeProjectName}`, '-q'],
        params.cwd,
      );
      if (containerIds.length > 0) {
        await runDocker(['rm', '-f', '-v', ...containerIds], params.cwd, { captureStdout: false });
      }

      const networkIds = await listDockerResourceIds(
        ['network', 'ls', '--filter', `label=com.docker.compose.project=${composeProjectName}`, '-q'],
        params.cwd,
      );
      if (networkIds.length > 0) {
        await runDocker(['network', 'rm', ...networkIds], params.cwd, { captureStdout: false });
      }

      const volumeIds = await listDockerResourceIds(
        ['volume', 'ls', '--filter', `label=com.docker.compose.project=${composeProjectName}`, '-q'],
        params.cwd,
      );
      if (volumeIds.length > 0) {
        await runDocker(['volume', 'rm', ...volumeIds], params.cwd, { captureStdout: false });
      }
    },
    up: async ({ apiReplicas, workerReplicas }) => {
      await runDocker(
        composeArgs(
          'up',
          '-d',
          '--no-build',
          '--remove-orphans',
          '--scale',
          `api=${apiReplicas}`,
          '--scale',
          `worker=${workerReplicas}`,
        ),
        params.cwd,
        { captureStdout: false },
      );
    },
    down: async () => {
      await runDocker(composeArgs('down', '--remove-orphans'), params.cwd, { captureStdout: false });
    },
    restart: async (service) => {
      await runDocker(composeArgs('restart', service), params.cwd, { captureStdout: false });
    },
    start: async (service) => {
      await runDocker(composeArgs('start', service), params.cwd, { captureStdout: false });
    },
    stop: async (service) => {
      await runDocker(composeArgs('stop', service), params.cwd, { captureStdout: false });
    },
    stopContainer: async (containerId) => {
      await runDocker(['stop', containerId], params.cwd, { captureStdout: false });
    },
    killContainer: async (containerId) => {
      await runDocker(['kill', containerId], params.cwd, { captureStdout: false });
    },
    ps: async () => {
      return await runDocker(composeArgs('ps', '--format', 'json'), params.cwd);
    },
    logs: async () => {
      return await runDocker(composeArgs('logs', '--no-color'), params.cwd);
    },
    serviceContainerIds: async (service) => {
      const output = await runDocker(composeArgs('ps', '-q', service), params.cwd);
      return output
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    inspectContainers: async (containerIds) => {
      if (containerIds.length === 0) return [];
      const output = await runDocker(['inspect', ...containerIds], params.cwd);
      return JSON.parse(output) as unknown[];
    },
    execCapture: async (service, command) => {
      return await runDocker(composeArgs('exec', '-T', service, ...command), params.cwd);
    },
  };
}
