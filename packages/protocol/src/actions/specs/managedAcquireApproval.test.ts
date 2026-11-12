import { describe, expect, it } from 'vitest';
import { MANAGED_MACHINE_ACTION_SPECS } from './managedMachines.js';
import { describeApprovalActionFields, projectApprovalReviewInput } from '../actionApprovalPresentation.js';
import { getActionSpec } from '../actionSpecs.js';
import type { ManagedMachineEnrollmentIdentityV1 } from '../../machines/managed/enrollmentIdentityV1.js';
import { describeManagedSize } from '../../machines/managed/configurationPresentation.js';

describe('managed acquire review', () => {
  it('reads the reviewed local Lima configuration without raw native records, in pending and retained review', () => {
    const spec = getActionSpec('machines.managed.acquire');
    const launch = { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
      name: 'Build machine', choices: { cpus: 4, memoryGiB: 4, diskGiB: 100 } };
    const nativeFacts = { size: { id: '4/4/100', title: { key: 'machineLima.presentation.customSize', fallback: 'Custom size' },
      cpuCores: 4, memoryBytes: 4 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 },
      image: { id: 'https://images.example/ubuntu.img', title: 'Ubuntu 26.04' } };
    const input = spec.inputSchema.parse({ selection: { kind: 'one-off', homeId: 'home', launch,
      retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true },
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
      reviewedFacts: { launch, optionStatus: 'current', prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' },
        nativeFacts,
        retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
        retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true },
    });
    for (const [status, actionArgs] of [['pending', input], ['executed', projectApprovalReviewInput(spec, input)]] as const) {
      const projection = describeApprovalActionFields({ actionId: spec.id, actionArgs, status });
      expect(projection.unrepresentable).toBeNull();
      expect(projection.rows).toContainEqual(expect.objectContaining({ path: 'price', value: 'No bill' }));
      const reading = projection.rows.map(row => row.kind === 'value' ? row.value : '').join('\n').replaceAll('\u00a0', ' ');
      expect(projection.rows).toContainEqual(expect.objectContaining({ path: 'nativeFacts',
        value: expect.stringContaining(describeManagedSize('Custom size', nativeFacts.size)) }));
      for (const fact of ['Custom size', '4 cores', '4 GiB', '100 GiB', 'Ubuntu 26.04', '1 h']) expect(reading).toContain(fact);
      for (const raw of ['3600000', '4294967296', '107374182400', 'machineLima.presentation', 'https://images.example', 'billed directly']) {
        expect(reading).not.toContain(raw);
      }
      expect(projection.rows.find(row => row.path === 'nativeFacts')).not.toHaveProperty('entries');
    }
    expect(spec.approvalPresentation?.summary(input)).toContain('No bill');
    expect(spec.approvalPresentation?.summary(input)).toContain('1 h');
    // Already recorded approvals carried the native record, before this presentation changed.
    const retained = projectApprovalReviewInput(spec, input);
    if (!retained || typeof retained !== 'object') throw new Error('Missing retained review');
    const legacy = { ...retained, nativeFacts };
    const history = describeApprovalActionFields({ actionId: spec.id, actionArgs: legacy, status: 'executed' });
    expect(history.unrepresentable).toBeNull();
    expect(history.rows).toContainEqual(expect.objectContaining({ path: 'nativeFacts', value: expect.stringContaining('Ubuntu 26.04') }));
    expect(history.rows).toContainEqual(expect.objectContaining({ path: 'nativeFacts',
      value: expect.stringContaining(describeManagedSize('Custom size', nativeFacts.size)) }));
    expect(history.rows.find(row => row.path === 'nativeFacts')).not.toHaveProperty('entries');
  });

  it.each([
    [{ kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' },
      ['Runs as a dedicated user on the machine', 'Agents share a Linux user until separate users are enabled in Security'], 'approvalServer'],
    [{ kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation: 'ask', administrator: { username: 'maintainer' } },
      ['Runs as a dedicated user on the machine', 'Agents share a Linux user until separate users are enabled in Security'], 'approvalDeployTarget'],
    [{ kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
      ['Runs as a dedicated user on the machine', 'Agents share a Linux user until separate users are enabled in Security'], 'approvalServer'],
    [{ kind: 'existingUser', role: 'personal' }, ['Runs as your existing account on your personal machine'], 'approvalPersonal'],
    [{ kind: 'existingUser', role: 'adopted' }, ['Runs as the existing account on the adopted machine'], 'approvalAdopted'],
    [{ kind: 'guestProcess', role: 'sandbox' }, ['Runs as a process inside the sandbox'], 'approvalSandbox'],
  ] satisfies [ManagedMachineEnrollmentIdentityV1, string[], string][])('reads the reviewed identity in words, including retained history (%j)', (enrollmentIdentity, facts, key) => {
    const spec = getActionSpec('machines.managed.acquire');
    const input = spec.inputSchema.parse({ selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true, enrollmentIdentity });
    for (const [status, actionArgs] of [
      ['pending', input], ['executed', projectApprovalReviewInput(spec, input)],
    ] as const) {
      const projection = describeApprovalActionFields({ actionId: spec.id, actionArgs, status });
      expect(projection.unrepresentable).toBeNull();
      const rows = projection.rows.filter(row => row.path.startsWith('enrollmentIdentity'));
      const identity = rows.find(row => row.path === 'enrollmentIdentity.role');
      expect(identity).toEqual(expect.objectContaining({ kind: 'value', selectedOptions: [expect.objectContaining({
        labelKey: `managedMachines.identity.${key}`,
      })] }));
      const reading = rows.map(row => row.kind === 'value' ? row.value : '').join('\n');
      for (const fact of facts) expect(reading).toContain(fact);
      expect(reading).not.toContain(JSON.stringify(enrollmentIdentity));
      expect(rows.some(row => row.kind === 'value' && row.entries)).toBe(false);
      if (enrollmentIdentity.kind === 'dedicatedDaemonUser') {
        expect(rows).toContainEqual(expect.objectContaining({ path: 'enrollmentIdentity.username', value: 'happier' }));
        expect(rows).toContainEqual(expect.objectContaining({ path: 'enrollmentIdentity.adminAccessAtCreation',
          value: { ask: 'Ask each time', none: 'None', preauthorized: 'Preauthorized' }[enrollmentIdentity.adminAccessAtCreation] }));
        if (enrollmentIdentity.administrator) expect(rows).toContainEqual(expect.objectContaining({
          path: 'enrollmentIdentity.administrator.username', value: 'maintainer',
        }));
      }
    }
  });

  it('keeps billing unknown for an unpriced preset without billing facts', () => {
    const spec = MANAGED_MACHINE_ACTION_SPECS.find(candidate => candidate.id === 'machines.managed.acquire');
    if (!spec) throw new Error('Missing managed acquire Action');
    const input = spec.inputSchema.parse({ selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
    expect(spec.approvalPresentation?.summary(input)).toContain('Price unavailable');
    expect(spec.approvalPresentation?.summary(input)).not.toContain('billed directly');
  });

  it.each([
    [{ kind: 'unused', afterMs: 7200000 }, ['Native expiry', '2 h']],
    [{ kind: 'deadline', at: 1793500000000 }, ['Native expiry', 'running work may be interrupted']],
    [undefined, ['Finite provider lifetime', 'expiry unavailable']],
  ])('discloses a finite provider lifetime separately from the Keep preference (%j)', (nativeExpiry, facts) => {
    const spec = MANAGED_MACHINE_ACTION_SPECS.find(candidate => candidate.id === 'machines.managed.acquire');
    if (!spec) throw new Error('Missing managed acquire Action');
    const launch = { provider: { pluginId: 'happier.machine.vercel', localId: 'vercel' }, schemaVersion: 1,
      name: 'Sandbox', choices: {} };
    const input = spec.inputSchema.parse({ selection: { kind: 'one-off', homeId: 'home', launch,
      retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: false },
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
      reviewedFacts: { launch, optionStatus: 'current', prerequisites: [],
        billing: { location: 'cloud', stoppedBilling: 'not-billed' },
        retentionCapabilities: { supportedIntents: ['stop', 'delete'], finiteOnly: true,
          ...(nativeExpiry ? { nativeExpiry } : {}) },
        retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: false },
    });
    const summary = spec.approvalPresentation?.summary(input);
    expect(summary).toContain('1 h');
    expect(summary).not.toContain('milliseconds');
    for (const fact of facts) expect(summary).toContain(fact);
  });
});
