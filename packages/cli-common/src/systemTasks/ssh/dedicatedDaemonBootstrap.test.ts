import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { checkMachineSetupEffectPlan, applyMachineSetupEffectPlans, createMachineSetupEffectPlan, type MachineSetupBackend, type MachineSetupStepObservationV1 } from '../../machineSetup/index.js';
import * as bootstrap from '../nativeRemoteSshBootstrap.js';
import { DEDICATED_DAEMON_INSTALL_HOME } from './remoteBootstrapCommandBuilder.js';

describe('portable dedicated daemon bootstrap', () => {
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
            path: `${DEDICATED_DAEMON_INSTALL_HOME}/tools`, owner: 'happier', group: 'happier', mode: 0o755,
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
        if (request.command === 'which docker') return { status: 1, stdout: '', stderr: '' };
        if (!request.input) {
          phases.push('grant');
          return { status: 0, stdout: '', stderr: '' };
        }
        const [requestLine, credentialLine] = request.input.trimEnd().split('\n');
        const frame = bootstrap.MachineEffectInternalRequestSchema.parse(JSON.parse(requestLine!));
        phases.push(frame.mode);
        if (frame.mode === 'check' && 'steps' in frame) {
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
    expect(events.filter(event => event && typeof event === 'object' && 'stepId' in event && event.stepId === 'bootstrap-complete')).toHaveLength(1);
    expect(events.filter(event => event && typeof event === 'object' && 'type' in event && event.type === 'progress')).toEqual([
      { type: 'progress', stepId: 'bootstrap-check', message: 'Checking machine setup' },
      { type: 'progress', stepId: 'bootstrap-apply', message: 'Setting up the machine' },
      { type: 'progress', stepId: 'bootstrap-complete', message: 'Verifying machine setup' },
    ]);
    expect(JSON.stringify([commands, events, task])).not.toContain(password);
  });
});
