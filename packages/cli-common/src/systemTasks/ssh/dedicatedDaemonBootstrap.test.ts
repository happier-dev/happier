import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { checkMachineSetupEffectPlan, applyMachineSetupEffectPlans, createMachineSetupEffectPlan, type MachineSetupBackend, type MachineSetupStepObservationV1 } from '../../machineSetup/index.js';
import * as bootstrap from '../nativeRemoteSshBootstrap.js';
import { DEDICATED_DAEMON_INSTALL_HOME } from './remoteBootstrapCommandBuilder.js';
import { installRemoteCli } from './installRemoteCli.js';

describe('portable dedicated daemon bootstrap', () => {
  it.skipIf(process.platform === 'win32').each(['systemctl', 'loginctl', 'runuser'])('reports an unsupported guest before account creation when %s is absent', async missing => {
    const directory = await mkdtemp(join(tmpdir(), 'mach-devc-identity-'));
    try {
      await symlink('/bin/sh', join(directory, 'sh'));
      // OS command boundary: no host account or service mutations are possible.
      for (const name of ['id', 'uname', 'systemctl', 'loginctl', 'runuser']) {
        if (name === missing) continue;
        await writeFile(join(directory, name), `#!/bin/sh\necho ${name === 'uname' ? 'Linux' : '0'}\n`, { mode: 0o755 });
      }
      await expect(installRemoteCli({ channel: 'stable', bootstrap: {
        parsed: { relay: { relayUrl: 'https://home.example' },
          enrollmentIdentity: ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser',
            username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' }),
          ssh: { target: 'root@guest', auth: 'agent' } },
        context: { taskId: 'unsupported-guest', emit: () => {}, prompt: async () => { throw new Error('No prompt expected'); } },
        createPromptId: () => 'unused',
      }, transport: {
        install: async () => { throw new Error('An unsupported guest must not install a payload'); },
        exec: async ({ command }) => {
          try {
            const result = await promisify(execFile)('/bin/sh', ['-c', command], { env: { PATH: directory } });
            return { status: 0, ...result };
          } catch (error) {
            const result = error as Error & { code: number; stdout: string; stderr: string };
            return { status: result.code, stdout: result.stdout, stderr: result.stderr };
          }
        },
      } })).rejects.toMatchObject({ code: 'dedicated_identity_unsupported' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { state: 'cold or partial bootstrap without completion', bootstrapInstalled: undefined, enrolledMachineId: undefined, prepare: true },
    { state: 'completed bootstrap awaiting enrollment', bootstrapInstalled: true as const, enrolledMachineId: undefined, prepare: false },
    { state: 'enrolled retained machine', bootstrapInstalled: undefined, enrolledMachineId: 'retained-machine', prepare: false },
  ])('refreshes the payload for $state and prepares only unfinished creation', async scenario => {
    const identity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser', username: 'happier',
      serviceMode: 'user', role: 'server', adminAccessAtCreation: 'ask', administrator: { username: 'operator' } });
    const phases: string[] = [];
    const backend: MachineSetupBackend = {
      observe: async (step): Promise<MachineSetupStepObservationV1> => ({ stepId: step.id, status: 'satisfied',
        facts: step.kind === 'user' ? { present: true, uid: 1002 } : {} }),
      apply: async () => { throw new Error('Satisfied native state needs no mutation'); },
    };
    await installRemoteCli({ channel: 'stable', bootstrap: {
      parsed: { relay: { relayUrl: 'https://home.example' }, enrollmentIdentity: identity,
        ssh: { target: 'happier@server', auth: 'agent' } },
      bootstrapInstalled: scenario.bootstrapInstalled, enrolledMachineId: scenario.enrolledMachineId,
      context: { taskId: 'retained-install', emit: () => {}, prompt: async () => { throw new Error('Existing administrator needs no establishment'); } },
      createPromptId: () => 'unused',
    }, transport: {
      install: async placement => {
        phases.push('install');
        expect(placement).toEqual({ remoteHomeDir: DEDICATED_DAEMON_INSTALL_HOME, daemonUsername: 'happier' });
        return { binaryPath: '/opt/happier/cli/current/happier' };
      },
      exec: async request => {
        if (!scenario.prepare) throw new Error('Completed creation cannot reacquire passwordless root');
        if (request.command === 'uname -s') return { status: 0, stdout: 'Linux\n', stderr: '' };
        if (request.command.includes('useradd')) { phases.push('account'); return { status: 0, stdout: '', stderr: '' }; }
        if (request.command.includes('/etc/os-release')) return { status: 0, stdout: 'ubuntu\n', stderr: '' };
        if (request.command === 'id -u happier') return { status: 0, stdout: '1001\n', stderr: '' };
        const frame = bootstrap.MachineEffectInternalRequestSchema.parse(JSON.parse(request.input!.trim()));
        phases.push(frame.mode);
        if (frame.mode === 'check' && 'steps' in frame) {
          const plan = await checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend });
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: { status: 'checked', plan } }), stderr: '' };
        }
        if (frame.mode !== 'apply' || !('plans' in frame)) throw new Error('Expected reviewed bootstrap apply');
        const result = await applyMachineSetupEffectPlans({ plans: frame.plans, backend });
        return { status: 0, stdout: JSON.stringify({ type: 'result', result }), stderr: '' };
      },
    } });
    expect(phases).toEqual(scenario.prepare ? ['account', 'install', 'check', 'apply'] : ['install']);
  });

  it('uses an existing administrator without an establishment question, credential frame, or password-state declaration', async () => {
    const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser', username: 'happier',
      serviceMode: 'user', role: 'server', adminAccessAtCreation: 'ask', administrator: { username: 'operator' } });
    if (enrollmentIdentity.kind !== 'dedicatedDaemonUser') throw new Error('Dedicated fixture required');
    let applied = false;
    await bootstrap.prepareDedicatedDaemonBootstrap({
      task: { taskId: 'existing-admin', enrollmentIdentity, sshTarget: 'operator@server', relayUrl: 'https://home.example' },
      binaryPath: '/opt/happier/cli/current/happier', channel: 'stable', createPromptId: () => 'unused', emit: () => {},
      prompt: async () => { throw new Error('Existing administrators use their existing sudo password when work runs'); },
      exec: async request => {
        if (request.command.includes('/etc/os-release')) return { status: 0, stdout: 'ubuntu\nnoble\namd64\n', stderr: '' };
        if (request.command === 'id -u happier') return { status: 0, stdout: '1001\n', stderr: '' };
        const lines = request.input!.trimEnd().split('\n');
        const frame = bootstrap.MachineEffectInternalRequestSchema.parse(JSON.parse(lines[0]!));
        if (frame.mode === 'check' && 'steps' in frame) {
          expect(frame.steps.find(step => step.id === 'tools-root')).toMatchObject({
            path: `${DEDICATED_DAEMON_INSTALL_HOME}/tools`, owner: 'happier', group: 'happier', mode: 0o711,
          });
          const administrator = frame.steps.find(step => step.id === 'bootstrap-administrator');
          expect(administrator).toEqual({ id: 'bootstrap-administrator', kind: 'user', username: 'operator' });
          const plan = createMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps,
            nativeFacts: frame.steps.map((step): MachineSetupStepObservationV1 => ({ stepId: step.id, status: 'satisfied',
              facts: step.id === 'bootstrap-administrator' ? { present: true, uid: 1002 } : {} })) });
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n', stderr: '' };
        }
        if (frame.mode !== 'apply') throw new Error('Expected apply');
        expect('administrator' in frame).toBe(false);
        expect(lines).toHaveLength(1);
        applied = true;
        return { status: 0, stdout: JSON.stringify({ type: 'result', result: {
          status: 'applied', completedStepIds: [], daemonRestartRequired: false,
        } }) + '\n', stderr: '' };
      },
    });
    expect(applied).toBe(true);
  });

  it('bundles the shared installer lifecycle and dedicated bootstrap for browsers without Node shims or externalization', async () => {
    const { build } = await import('esbuild');
    const result = await build({ entryPoints: [fileURLToPath(new URL('./installRemoteCli.ts', import.meta.url))],
      bundle: true, platform: 'browser', format: 'esm', conditions: ['browser', 'react-native', 'happier-source'],
      metafile: true, write: false, logLevel: 'silent' });
    expect(result.outputFiles?.length).toBeGreaterThan(0);
    expect(Object.keys(result.metafile.inputs).some(path => path.endsWith('/ssh/dedicatedDaemonBootstrap.ts'))).toBe(true);
  });

  it.each(['ask', 'preauthorized', 'none'] as const)('composes shared dedicated %s bootstrap through the existing interpreter', async adminAccessAtCreation => {
    const phases: string[] = [];
    const commands: string[] = [];
    const events: unknown[] = [];
    const appliedSteps = new Set<string>();
    const password = 'transient-bootstrap-password';
    const identity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser', username: 'happier',
      serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation,
      ...(adminAccessAtCreation === 'ask' ? { administrator: { username: 'operator' } } : {}) });
    if (identity.kind !== 'dedicatedDaemonUser') throw new Error('Dedicated fixture required');
    const task = { taskId: 'admitted-bootstrap-task', enrollmentIdentity: identity, sshTarget: 'root@server', relayUrl: 'https://home.example' };
    // The remote OS is the boundary; shared composition, IPC, plan checking and Apply stay real.
    const backend: MachineSetupBackend = {
      observe: async (step): Promise<MachineSetupStepObservationV1> => ({ stepId: step.id, status: appliedSteps.has(step.id) ? 'satisfied' : 'drifted',
        facts: step.kind === 'user' ? appliedSteps.has(step.id) ? { present: true, uid: 1002 } : { present: false } : {} }),
      apply: async step => { appliedSteps.add(step.id); return step.kind === 'user' ? { createdUser: true } : undefined; },
      establishAdministrator: async credential => { expect(new TextDecoder().decode(credential.password)).toBe(password); },
    };
    await bootstrap.prepareDedicatedDaemonBootstrap?.({ task, binaryPath: '/opt/happier/cli/current/happier', channel: 'stable',
      createPromptId: () => 'fresh-administrator-prompt', emit: event => { events.push(event); },
      prompt: async question => {
        phases.push('prompt');
        expect(question).toMatchObject({ kind: 'administrator.establish', data: { promptId: 'fresh-administrator-prompt', administratorUsername: 'operator' } });
        return { password };
      },
      exec: async request => {
        commands.push(request.command);
        if (request.command.includes('/etc/os-release')) return { status: 0, stdout: 'ubuntu\nnoble\namd64\n', stderr: '' };
        if (request.command === 'id -u happier') return { status: 0, stdout: '1001\n', stderr: '' };
        if (request.command === 'which dockerd') return { status: 1, stdout: '', stderr: '' };
        if (!request.input) {
          phases.push('grant');
          return { status: 0, stdout: '', stderr: '' };
        }
        const [requestLine, credentialLine] = request.input.trimEnd().split('\n');
        const frame = bootstrap.MachineEffectInternalRequestSchema.parse(JSON.parse(requestLine!));
        phases.push(frame.mode);
        if (frame.mode === 'check' && 'steps' in frame) {
          // A user unit's default.target enablement needs a persistent user
          // manager at boot, even when nobody logs in as the locked daemon user.
          expect(frame.steps).toContainEqual({
            id: 'daemon-user-linger', kind: 'command', executable: 'loginctl', args: ['enable-linger', 'happier'],
            check: { executable: 'test', args: ['-f', '/var/lib/systemd/linger/happier'], unsatisfiedExitCodes: [1] },
          });
          // Boot must pull in the manager even on images where logind does not
          // activate a lingering account. Its template owns the runtime dir.
          expect(frame.steps).toContainEqual({
            id: 'daemon-user-manager-boot', kind: 'command', executable: 'systemctl',
            args: ['add-wants', '--', 'multi-user.target', 'user@1001.service'],
            check: { executable: 'test', args: ['-e', '/etc/systemd/system/multi-user.target.wants/user@1001.service'], unsatisfiedExitCodes: [1] },
          });
          expect(frame.basis).toEqual({ kind: 'sshBootstrap', operationId: task.taskId,
            admittedInputDigest: createHash('sha256').update(createCanonicalJsonSigningInput({ ...task, channel: 'stable' })).digest('hex') });
          const plan = await checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend });
          return { status: 0, stdout: JSON.stringify({ type: 'progress', stepId: 'bootstrap-check', phase: 'check', status: 'started' }) + '\n'
            + JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n', stderr: '' };
        }
        if (frame.mode !== 'apply' || !('plans' in frame)) throw new Error('Expected the same reviewed Apply');
        const establishment = credentialLine ? bootstrap.MachineAdministratorEstablishFrameSchema.parse(JSON.parse(credentialLine)) : undefined;
        expect(Boolean(establishment)).toBe(adminAccessAtCreation === 'ask');
        const result = await applyMachineSetupEffectPlans({ plans: frame.plans, backend,
          ...(establishment ? { administratorEstablishment: { stepId: establishment.stepId, username: establishment.username,
            password: new TextEncoder().encode(establishment.password) } } : {}),
          onProgress: progress => { events.push({ type: 'interpreter-progress', ...progress }); },
        });
        const stdout = JSON.stringify({ type: 'progress', stepId: 'bootstrap-apply', phase: 'apply', status: 'started' }) + '\n'
          + JSON.stringify({ type: 'progress', stepId: 'bootstrap-complete', phase: 'verify', status: 'satisfied' }) + '\n'
          + JSON.stringify({ type: 'result', result }) + '\n';
        request.onStdoutChunk?.(stdout.slice(0, 9));
        request.onStdoutChunk?.(stdout.slice(9));
        return { status: 0, stdout, stderr: '' };
      },
    });
    expect(phases).toEqual(adminAccessAtCreation === 'ask' ? ['check', 'prompt', 'apply']
      : adminAccessAtCreation === 'preauthorized' ? ['check', 'apply', 'grant'] : ['check', 'apply']);
    expect(appliedSteps.has('docker-membership')).toBe(true);
    expect(appliedSteps.has('daemon-user-linger')).toBe(true);
    expect(appliedSteps.has('daemon-user-manager-boot')).toBe(true);
    expect(events.filter(event => event && typeof event === 'object' && 'stepId' in event && event.stepId === 'bootstrap-complete')).toHaveLength(1);
    expect(events.filter(event => event && typeof event === 'object' && 'type' in event && event.type === 'progress')).toEqual([
      { type: 'progress', stepId: 'bootstrap-check', message: 'Checking machine setup' },
      { type: 'progress', stepId: 'bootstrap-apply', message: 'Setting up the machine' },
      { type: 'progress', stepId: 'bootstrap-complete', message: 'Verifying machine setup' },
    ]);
    expect(JSON.stringify([commands, events, task])).not.toContain(password);
  });
});
