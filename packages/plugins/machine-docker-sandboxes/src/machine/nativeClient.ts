import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { DockerSandboxesLaunchV1Schema, DockerSandboxesNameSchema, DockerSandboxesResourceV1Schema } from './schemas.js';
import type { DockerSandboxesLaunchV1 } from './schemas.js';
import type { DockerSandboxesResourceV1 as SandboxLocator } from './schemas.js';

function isSandboxName(value: string) {
  return DockerSandboxesNameSchema.safeParse(value).success;
}

function readLocator(resource: SandboxLocator): SandboxLocator {
  return {
    sandboxName: resource.sandboxName,
  };
}

function completed(result: PluginProcessResult) {
  return result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0
    && result.termination.requestedBy.kind === 'none';
}

const invalidName = () => ({ status: 'refused', code: 'docker_sandbox_name_invalid' } as const);
const invalidResource = () => ({ status: 'refused', code: 'docker_sandbox_resource_invalid' } as const);

/** Native evidence only. Registration, enrollment and lifecycle policy stay with the host. */
export function createDockerSandboxesNativeClient(exec: Pick<ExecService, 'run'>, executable: ManagedExecutableRef) {
  const run = (args: readonly string[], signal?: AbortSignal, stdin?: Uint8Array) => {
    signal?.throwIfAborted();
    return exec.run({ executable, args, ...(stdin === undefined ? {} : { stdin }) }, { signal });
  };
  const client = {
    async create(input: DockerSandboxesLaunchV1, signal?: AbortSignal) {
      const launch = DockerSandboxesLaunchV1Schema.safeParse(input);
      if (!launch.success) return { status: 'refused', code: 'docker_sandbox_launch_invalid' } as const;
      const resource = { sandboxName: launch.data.name };
      try {
        const result = await run(['create', '--name', launch.data.name, '--template', launch.data.templateId, 'shell'], signal);
        if (completed(result)) return { status: 'allocated', resource, readiness: 'unqualified' } as const;
      } catch {
        // The native effect may precede loss of its process result. Keep its
        // preselected locator; the host decides recovery, never a new acquire.
      }
      return { status: 'unknown', resource, nativeAbsence: 'unproven' } as const;
    },
    async probe(signal?: AbortSignal) {
      try {
        const result = await run(['version'], signal);
        return { status: completed(result) ? 'available' : 'unavailable', readiness: 'unqualified' } as const;
      } catch {
        return { status: 'unavailable', readiness: 'unqualified' } as const;
      }
    },
    async templates(signal?: AbortSignal) {
      try {
        const result = await run(['template', 'ls', '--quiet'], signal);
        if (completed(result) && !result.stdoutTruncated) {
          const templateIds = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).split(/\r?\n/u).filter(Boolean);
          if (templateIds.every(templateId => DockerSandboxesLaunchV1Schema.safeParse({ templateId, name: 'happier' }).success)) {
            return { status: 'available', templateIds } as const;
          }
        }
      } catch { /* A failed/partial native catalog cannot supply choices. */ }
      return { status: 'unavailable' } as const;
    },
    async inspect(resource: SandboxLocator, signal?: AbortSignal) {
      if (!isSandboxName(resource.sandboxName)) return invalidName();
      if (!DockerSandboxesResourceV1Schema.safeParse(resource).success) return invalidResource();
      const locator = readLocator(resource);
      try {
        // v0.46.0 quiet output establishes inventory presence independently
        // of the native power observation; it is never enrollment evidence.
        const result = await run(['ls', '--quiet'], signal);
        if (completed(result) && !result.stdoutTruncated) {
          const names = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).split(/\r?\n/u).filter(Boolean);
          if (names.every(isSandboxName)) {
            return { presence: names.includes(locator.sandboxName) ? 'present' : 'absent', resource: locator, readiness: 'unqualified' } as const;
          }
        }
      } catch {
        // A failed, malformed or partial inventory cannot establish absence.
      }
      return { presence: 'unknown', resource: locator, readiness: 'unqualified' } as const;
    },
    async power(resource: SandboxLocator, signal?: AbortSignal): Promise<'running' | 'stopped' | 'unknown'> {
      if (!DockerSandboxesResourceV1Schema.safeParse(resource).success) return 'unknown';
      try {
        // v0.46.0 (991967dc90ce) commands.jsonLsEntry: name/status and
        // guest_unresponsive are native JSON fields. Extra native facts are
        // ignored; no command acceptance or unrelated sandbox supplies power.
        const result = await run(['ls', '--json'], signal);
        if (!completed(result) || result.stdoutTruncated) return 'unknown';
        const inventory: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout));
        if (typeof inventory !== 'object' || inventory === null || !('sandboxes' in inventory)
          || !Array.isArray(inventory.sandboxes)) return 'unknown';
        const values = inventory.sandboxes;
        let power: 'running' | 'stopped' | 'unknown' | undefined;
        for (const value of values) {
          if (typeof value !== 'object' || value === null || !('name' in value) || typeof value.name !== 'string') return 'unknown';
          if (value.name !== resource.sandboxName) continue;
          if (power !== undefined) return 'unknown';
          if ('guest_unresponsive' in value && value.guest_unresponsive !== false) power = 'unknown';
          else power = 'status' in value && (value.status === 'running' || value.status === 'stopped') ? value.status : 'unknown';
        }
        return power ?? 'unknown';
      } catch { return 'unknown'; }
    },
    async exec(resource: SandboxLocator, command: readonly string[], signal?: AbortSignal, input?: Uint8Array) {
      if (!DockerSandboxesResourceV1Schema.safeParse(resource).success) {
        throw Object.assign(new Error('invalid native resource'), { code: 'docker_sandbox_resource_invalid' });
      }
      if (command.length === 0 || command.some(argument => argument.includes('\0'))) {
        throw Object.assign(new Error('invalid native command'), { code: 'invalid_request' });
      }
      const locator = readLocator(resource);
      // No TTY, environment variable, uploaded script or public command argument
      // carries private bytes. Native stdin and buffered binary output remain
      // with the admitted invocation's existing ExecService owner.
      return run(['exec', ...(input === undefined ? [] : ['--interactive']), '--', locator.sandboxName, ...command], signal, input);
    },
    async start(resource: SandboxLocator, signal?: AbortSignal) {
      const observation = await client.inspect(resource, signal);
      if (!('presence' in observation)) return observation;
      if (observation.presence !== 'present') return { status: 'refused', code: observation.presence === 'absent'
        ? 'docker_sandbox_absent' : 'docker_sandbox_presence_unknown' } as const;
      try {
        if (completed(await run(['run', '--detached', '--name', resource.sandboxName], signal))) {
          return { status: 'start-accepted', resource: readLocator(resource) } as const;
        }
      } catch { /* Native acceptance may precede loss of the process reply. */ }
      return { status: 'unknown', resource: readLocator(resource), nativeAbsence: 'unproven' } as const;
    },
    async stop(resource: SandboxLocator, signal?: AbortSignal) {
      if (!isSandboxName(resource.sandboxName)) return invalidName();
      if (!DockerSandboxesResourceV1Schema.safeParse(resource).success) return invalidResource();
      const locator = readLocator(resource);
      try {
        const result = await run(['stop', locator.sandboxName], signal);
        if (completed(result)) return { status: 'stop-accepted', resource: locator, nativeAbsence: 'unproven' } as const;
      } catch {
        // Stop leaves the same retained resource; acceptance is not power proof.
      }
      return { status: 'unknown', resource: locator, nativeAbsence: 'unproven' } as const;
    },
    async delete(resource: SandboxLocator, signal?: AbortSignal) {
      if (!isSandboxName(resource.sandboxName)) return invalidName();
      if (!DockerSandboxesResourceV1Schema.safeParse(resource).success) return invalidResource();
      const locator = readLocator(resource);
      try {
        const result = await run(['rm', '--force', locator.sandboxName], signal);
        if (completed(result)) return { status: 'delete-accepted', resource: locator, nativeAbsence: 'unproven' } as const;
      } catch {
        // A failed/lost command result cannot prove native deletion.
      }
      return { status: 'unknown', resource: locator, nativeAbsence: 'unproven' } as const;
    },
  };
  return client;
}
