import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MachineServicesDiscoveryResultV1Schema,
  type MachineMetadataFieldReadV1,
  type MachineMetadataFieldPortV1,
} from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { MachineServiceExecInputV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineServiceExecAction } from '@/session/actions/cliActionDeps/machineServiceExec';
import { createMachineServicesRuntime } from './machineServices';

describe('watched Compose project exec and shell', () => {
  it.skipIf(process.platform === 'win32')(
    'runs a command and lends a shell in a selected Compose service through the installed plugin role and the real watch handle',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-watched-exec-'));
      const callsPath = join(root, 'calls.jsonl');
      const executablePath = join(root, 'docker');
      const webId = 'a'.repeat(64);
      const workerId = 'b'.repeat(64);
      // Genuine OS/Docker boundary only. Plugin activation, the lifecycle
      // capture, Exec launch authorization, the watch owner and the Action
      // consumer are real.
      await writeFile(
        executablePath,
        `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');
const ids=${JSON.stringify([webId, workerId])};
if(args.includes('info')) process.stdout.write(JSON.stringify({ID:'engine-a',OSType:'linux',Architecture:'x86_64'}));
else if(args[0]==='ps') process.stdout.write(ids.join('\\n')+'\\n');
else if(args[0]==='inspect') process.stdout.write(JSON.stringify(ids.map((id,index)=>({Id:id,Config:{Labels:{'com.docker.compose.project':'watched','com.docker.compose.service':index?'worker':'web','com.docker.compose.oneoff':'False'}},State:{Status:'running'}}))));
else if(args[0]==='exec') process.stdout.write('ran '+args.slice(1).join(' '));
else process.exitCode=19;
`,
        { mode: 0o700 },
      );
      await chmod(executablePath, 0o700);
      vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
      const target = { serverId: 'home', machineId: 'machine' };
      const context = {
        surface: 'cli' as const,
        authority: 'present_user' as const,
      };
      const adapter = {
        pluginId: 'happier.machine.services',
        localId: 'compose',
      };
      let metadata: MachineMetadataFieldReadV1 = {
        status: 'ready',
        metadataVersion: 1,
        metadata: { displayName: 'Machine' },
      };
      const port: MachineMetadataFieldPortV1 = {
        read: async () => metadata,
        compareAndSwap: async (input) => {
          if (metadata.status !== 'ready') return metadata;
          metadata = {
            status: 'ready',
            metadataVersion: metadata.metadataVersion + 1,
            metadata: input.metadata,
          };
          return { ...metadata, status: 'applied' };
        },
      };
      const runtime = createMachineServicesRuntime({
        target,
        readMetadata: () => metadata,
        captureMetadataPort: () => port,
      });
      let fixture:
        | Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>
        | undefined;
      try {
        fixture = await createAdmittedPluginRuntimeFixture({
          controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.machine.services'] },
        });
        const discovered = MachineServicesDiscoveryResultV1Schema.parse(
          await runtime.execute({
            actionId: 'machines.services.discovery',
            input: { ...target, adapter },
            context,
          }),
        );
        if (
          discovered.kind !== 'snapshot' ||
          discovered.candidates.length !== 1
        )
          throw new Error('Expected one native Compose project');
        const candidate = discovered.candidates[0]!;
        expect(
          await runtime.execute({
            actionId: 'machines.services.watch',
            context,
            input: {
              ...target,
              candidateId: candidate.candidateId,
              expectedRevision: candidate.revision,
              lifecyclePurpose: 'infrastructure',
            },
          }),
        ).toMatchObject({ kind: 'applied' });
        await runtime.execute({
          actionId: 'machines.services.list',
          input: target,
          context,
        });
        const handle =
          fixture.registry.projectManagedServices.listMachineServices()[0]!;
        expect(handle.kind).toBe('adopted');

        // The Action consumer selects the real handle; Machine-scope approval
        // is the only admission, decided once before the native effect.
        let admitted = 0;
        const exec = createMachineServiceExecAction({
          directMachineId: target.machineId,
          serverId: target.serverId,
          callMachineAction: async () => {
            throw new Error('unexpected remote dispatch');
          },
          admit: async () => {
            admitted++;
            return null;
          },
          assertCurrent: async () => {},
          canExecuteEnvironment: async () => {
            throw new Error('a watched service has no Environment');
          },
        });
        const actionContext = {
          ...context,
          operationAcceptance: {
            operationId: 'exec-1',
            actionId: 'machines.services.exec',
          },
        } as ActionExecutorContext;
        // Every request crosses the published wire schema first.
        const request = (service?: string) => MachineServiceExecInputV1Schema.parse({
          ...target,
          mode: 'exec' as const,
          argv: ['echo', 'hi'],
          target: {
            kind: 'current' as const,
            serviceId: handle.serviceId,
            expectedGeneration: handle.instanceId,
            ...(service ? { service } : {}),
          },
        });
        expect(
          await exec({
            input: request('worker'),
            context: actionContext,
            approvalScope: { kind: 'machine', machineId: target.machineId },
          }),
        ).toMatchObject({ exitCode: 0, stdout: `ran ${workerId} echo hi` });
        expect(admitted).toBe(1);

        // A service that is not a member of the watched project is refused before any Docker exec.
        expect(
          await exec({
            input: request('db'),
            context: actionContext,
            approvalScope: { kind: 'machine', machineId: target.machineId },
          }),
        ).toMatchObject({ ok: false, errorCode: 'service_selection_invalid' });
        // A multi-service project requires an explicit selection.
        expect(
          await exec({
            input: request(),
            context: actionContext,
            approvalScope: { kind: 'machine', machineId: target.machineId },
          }),
        ).toMatchObject({ ok: false, errorCode: 'service_selection_invalid' });
        // Approval for another Machine never admits this Machine's watch.
        expect(
          await exec({
            input: request('worker'),
            context: actionContext,
            approvalScope: { kind: 'machine', machineId: 'other-machine' },
          }),
        ).toMatchObject({ ok: false, errorCode: 'approval_stale' });
        // A requester the Machine owner refuses is stopped at admission.
        const refused = createMachineServiceExecAction({
          directMachineId: target.machineId,
          serverId: target.serverId,
          callMachineAction: async () => {
            throw new Error('unexpected remote dispatch');
          },
          admit: async () => ({
            ok: false,
            errorCode: 'machine_access_denied',
            error: 'machine_access_denied',
          }),
          assertCurrent: async () => {},
          canExecuteEnvironment: async () => true,
        });
        expect(
          await refused({
            input: request('worker'),
            context: actionContext,
            approvalScope: { kind: 'machine', machineId: target.machineId },
          }),
        ).toMatchObject({ ok: false, errorCode: 'machine_access_denied' });

        const shell = await handle.withServiceShell!(
          {
            operation: {
              operationId: 'shell-1',
              kind: 'machines.terminal.open',
            },
            service: 'web',
          },
          async (launch) => ({
            kind: 'not_started' as const,
            terminal: launch.args,
          }),
        );
        expect(shell.terminal.slice(-4)).toEqual([
          'exec',
          '-it',
          webId,
          '/bin/sh',
        ]);
        await expect(
          handle.withServiceShell!(
            {
              operation: {
                operationId: 'shell-2',
                kind: 'machines.terminal.open',
              },
              service: 'db',
            },
            async (launch) => ({
              kind: 'not_started' as const,
              terminal: launch.args,
            }),
          ),
        ).rejects.toMatchObject({ code: 'service_selection_invalid' });

        const calls = (await readFile(callsPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(calls.filter((args) => args[0] === 'exec')).toEqual([
          ['exec', workerId, 'echo', 'hi'],
        ]);
      } finally {
        await runtime.dispose();
        await fixture?.dispose();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
