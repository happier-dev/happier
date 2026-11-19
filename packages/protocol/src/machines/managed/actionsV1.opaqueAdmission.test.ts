import { describe, expect, it } from 'vitest';
import {
  ManagedAdmissionOutputV1Schema, ManagedAcquireInputV1Schema, ManagedAdmissionInputV1Schema, resolveManagedAcquireReviewV1,
  ManagedControllerContextOutputV1Schema,
  ManagedControllerMachineOutputV1Schema,
  ManagedControllerReportV1Schema,
  ManagedGetOutputV1Schema,
  ManagedListOutputV1Schema,
  ManagedMachineReadV1Schema,
  machineSetupApplyTargetFromPlanV1,
  MachineSetupPlanInputV1Schema,
  MachineSetupPlanResultV1Schema,
  MachineSetupResolveResultV1Schema,
  unwrapManagedMachineReadV1,
} from './actionsV1.js';
import { isManagedOpaquePresetMachineV1, ManagedMachineFullV1Schema, ManagedMachineV1Schema, ManagedOpaquePresetMachineV1Schema } from './managedMachineV1.js';

describe('managed acquire opaque admission', () => {
  it('retains source archive pins in existing admission and structural recovery rows', () => {
    const guestCli = { source: 'home-payload', line: '0.3', channel: 'stable', payloads: [{
      target: { os: 'linux', arch: 'arm64' }, sha256: 'a'.repeat(64),
      url: '/v1/runtime/guest-cli/payloads/linux/arm64',
    }] };
    const input = { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 0 } };
    expect(ManagedAdmissionInputV1Schema.parse({ input, requestId: 'start', continuationPresent: false, guestCli }))
      .toHaveProperty('guestCli', guestCli);
    expect(ManagedAcquireInputV1Schema.safeParse({ ...input, guestCli }).success).toBe(false);
    expect(ManagedAdmissionOutputV1Schema.parse({ machine: { ...row, guestCli }, presetContent, replayed: true }))
      .toHaveProperty('machine.guestCli', guestCli);
  });
  it('carries native local placement admission without accepting it as a public acquire choice', () => {
    const input = { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 0 } };
    expect(ManagedAcquireInputV1Schema.safeParse({ ...input, acquisitionMode: 'resource-bound', reuseIdle: true }).success).toBe(false);
    const admitted = ManagedAdmissionInputV1Schema.parse({ input, requestId: 'start', continuationPresent: false,
      acquisitionMode: 'resource-bound', reuseIdle: true });
    expect(admitted).toMatchObject({ acquisitionMode: 'resource-bound', reuseIdle: true });
    expect(ManagedAdmissionInputV1Schema.safeParse({ input, requestId: 'start', continuationPresent: false,
      reuseIdle: true }).success).toBe(false);
  });

  it('carries omitted preset policy unchanged until its signed native admission supplies qualified policy', () => {
    const input = { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 3 },
      controller: { machineId: 'controller', installationId: 'installation' },
      presetContentOverride: { content: { t: 'plain', v: { private: 'sealed override' } } } };
    const parsed = ManagedAcquireInputV1Schema.parse(input);
    expect(parsed).not.toHaveProperty('retention');
    expect(parsed).not.toHaveProperty('wakeOnAcceptedMessage');
    expect(resolveManagedAcquireReviewV1(parsed)).toMatchObject({ homeId: 'home', controller: input.controller });
    const native = ManagedAdmissionInputV1Schema.parse({ input: parsed, requestId: 'create', continuationPresent: false,
      presetPolicy: { retention: { kind: 'unused', afterMs: 3600000, effect: 'delete' }, wakeOnAcceptedMessage: false },
      originalActionEnvelope: { v: 1, requestId: 'create', input: parsed } });
    expect(native.input).toEqual(input);
    expect(native).toHaveProperty('presetPolicy.retention.effect', 'delete');
    const oneOff = { selection: { kind: 'one-off', homeId: 'home', launch: {
      provider: { pluginId: 'compute', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} } },
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } };
    expect(ManagedAcquireInputV1Schema.safeParse(oneOff).success).toBe(false);
  });

  const row = {
    id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    preset: { id: 'preset', revision: 3, contentEncryptionMode: 'plain' as const },
    controller: { machineId: 'controller', installationId: 'installation' },
    allocation: 'unsubmitted' as const, creationState: 'active' as const,
    desired: 'start' as const, desiredWhen: 'now' as const, intentRevision: 0,
    retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
  };
  const presetContent = { content: { t: 'plain' as const, v: { privateBody: 'admission must not inspect this' } }, recipients: [] as const };
  const readerProjection = { content: presetContent.content, recipientEnvelope: null };

  it('accepts a structural preset row with opaque content and rejects private launch leaves', () => {
    const output = ManagedAdmissionOutputV1Schema.parse({
      machine: row,
      presetContent,
      replayed: false,
    });
    expect(output).toMatchObject({ machine: row, presetContent });
    expect(ManagedAdmissionOutputV1Schema.safeParse({
      ...output, machine: { ...row, launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'leak', choices: {} } },
    }).success).toBe(false);
    expect(ManagedOpaquePresetMachineV1Schema.safeParse({
      ...row,
      enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
        adminAccessAtCreation: 'ask', administrator: { username: 'private-administrator' } },
    }).success).toBe(false);
  });

  it('classifies optional-never private leaves as opaque when local callers supply undefined', () => {
    const parsed = ManagedOpaquePresetMachineV1Schema.parse({ ...row, launch: undefined });
    expect(isManagedOpaquePresetMachineV1(parsed)).toBe(true);
  });

  it('unwraps both public managed-read branches at the protocol boundary', () => {
    const oneOff = ManagedMachineReadV1Schema.parse({
      ...row,
      preset: undefined,
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'one-off', choices: {} },
    });
    const opaque = ManagedMachineReadV1Schema.parse({ machine: row, presetContent: readerProjection });

    expect(unwrapManagedMachineReadV1(oneOff)).toEqual(oneOff);
    expect(unwrapManagedMachineReadV1(opaque)).toEqual(row);
  });

  it('keeps E2EE full preset snapshots internal while public machine wires require the opaque branch', () => {
    const fullPresetMachine = {
      ...row,
      preset: { ...row.preset, contentEncryptionMode: 'e2ee' as const },
      launch: {
        provider: { pluginId: 'acme.compute', localId: 'vm' },
        schemaVersion: 1,
        name: 'plaintext preset launch',
        choices: {},
      },
    };
    const fullOneOffMachine = { ...fullPresetMachine, preset: undefined };

    // Internal storage/opening code still needs to parse a full snapshot while
    // converting it into its recipient-safe projection.
    expect(ManagedMachineFullV1Schema.parse(fullPresetMachine)).toEqual(fullPresetMachine);
    // The legitimate public full branch remains available for one-off machines.
    expect(ManagedMachineV1Schema.parse(fullOneOffMachine)).toEqual(fullOneOffMachine);
    expect(ManagedMachineReadV1Schema.parse(fullOneOffMachine)).toEqual(fullOneOffMachine);
    expect(ManagedAdmissionOutputV1Schema.parse({ machine: fullOneOffMachine, replayed: false }))
      .toMatchObject({ machine: fullOneOffMachine });

    // An E2EE Full preset would disclose launch before opening its envelope.
    // Historical raw Plain projections are covered by the legacy owner tests.
    expect(ManagedMachineV1Schema.safeParse(fullPresetMachine).success).toBe(false);
    expect(ManagedMachineReadV1Schema.safeParse(fullPresetMachine).success).toBe(false);
    expect(ManagedAdmissionOutputV1Schema.safeParse({ machine: fullPresetMachine, replayed: false }).success).toBe(false);
    expect(ManagedControllerContextOutputV1Schema.safeParse({ machine: fullPresetMachine, requestId: 'request' }).success).toBe(false);
  });

  it('carries a sealed private acquire override through admission and restart context without raw input', async () => {
    const presetContentOverride = { content: { t: 'plain' as const, v: { opaque: 'private override' } } };
    expect(ManagedAdmissionOutputV1Schema.parse({
      machine: row,
      presetContent,
      presetContentOverride,
      replayed: false,
    })).toMatchObject({ presetContentOverride });
    expect(ManagedControllerContextOutputV1Schema.parse({
      machine: row,
      presetContent,
      requestId: 'request',
      presetContentOverride,
    })).toMatchObject({ presetContentOverride });
    expect(ManagedAdmissionOutputV1Schema.safeParse({
      machine: row, presetContent, requestedName: 'worker-2', replayed: false,
    }).success).toBe(false);
    const { ManagedAcquireInputV1Schema } = await import('./actionsV1.js');
    const presetAcquire = {
      selection: { kind: 'preset' as const, homeId: 'home', id: 'preset', revision: 3 },
      enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    };
    expect(ManagedAcquireInputV1Schema.safeParse({ ...presetAcquire,
      selection: { ...presetAcquire.selection, name: 'worker-2' },
    }).success).toBe(false);
    // The reviewed enrollment policy can include a dedicated administrator;
    // it belongs in the same opaque override snapshot, never Action input.
    expect(ManagedAcquireInputV1Schema.safeParse({ ...presetAcquire, presetContentOverride }).success).toBe(false);
    const { enrollmentIdentity: _identity, ...opaquePresetAcquire } = presetAcquire;
    expect(ManagedAcquireInputV1Schema.parse(opaquePresetAcquire)).toEqual(opaquePresetAcquire);
    expect(ManagedAcquireInputV1Schema.parse({ ...opaquePresetAcquire, presetContentOverride }))
      .toMatchObject({ presetContentOverride });
  });

  it('refuses reviewed launch facts on a preset acquire request', async () => {
    const { ManagedAcquireInputV1Schema } = await import('./actionsV1.js');
    const presetAcquire = {
      selection: { kind: 'preset' as const, homeId: 'home', id: 'preset', revision: 3 },
      retention: { kind: 'until-delete' as const },
      wakeOnAcceptedMessage: false,
      presetContentOverride: { content: { t: 'plain' as const, v: { opaque: 'private admission delta' } } },
    };
    // This baseline must be a valid preset arm: otherwise an unrelated malformed
    // field could mask the delegated-review regression this test protects.
    expect(ManagedAcquireInputV1Schema.safeParse(presetAcquire).success).toBe(true);
    expect(ManagedAcquireInputV1Schema.safeParse({
      ...presetAcquire,
      reviewedFacts: {
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'private', choices: {} },
        optionStatus: 'current' as const,
        prerequisites: [],
        billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
        retentionCapabilities: { supportedIntents: ['start' as const] },
        retention: { kind: 'until-delete' as const },
        wakeOnAcceptedMessage: false,
        reviewedEffectDigest: 'a'.repeat(64),
      },
    }).success).toBe(false);
  });

  it('uses the same structural machine through context while ordinary reads carry only the requesting recipient envelope', () => {
    expect(ManagedControllerContextOutputV1Schema.parse({ machine: row, presetContent, requestId: 'request' }))
      .toMatchObject({ machine: row, presetContent });
    expect(ManagedControllerMachineOutputV1Schema.parse({ machine: row })).toEqual({ machine: row });
    expect(ManagedListOutputV1Schema.parse({ machines: [{ machine: row, presetContent: readerProjection }] }))
      .toEqual({ machines: [{ machine: row, presetContent: readerProjection }] });
    expect(ManagedGetOutputV1Schema.parse({ machine: row, presetContent: readerProjection }))
      .toEqual({ machine: row, presetContent: readerProjection });
    expect(ManagedListOutputV1Schema.safeParse({ machines: [row] }).success).toBe(false);
  });

  it('admits only a structural opaque controller report', () => {
    const report = {
      homeId: 'home', managedId: 'managed', expectedIntentRevision: 0,
      requestId: 'request', controller: row.controller,
      result: { kind: 'bound' as const },
      presetContent: { t: 'plain' as const, v: { name: 'private machine override' } },
      observation: { observedAt: 1, availability: 'present' as const, power: 'running' as const },
    };
    expect(ManagedControllerReportV1Schema.safeParse(report).success).toBe(true);
    expect(ManagedControllerReportV1Schema.safeParse({ ...report, recipients: [] }).success).toBe(false);
    expect(ManagedControllerReportV1Schema.safeParse({ ...report, result: { kind: 'bound', resource: {
      contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { namespace: 'private' },
    } } }).success).toBe(false);
    expect(ManagedControllerReportV1Schema.safeParse({ ...report, observation: {
      ...report.observation, size: { label: 'private' }, nativeCause: { code: 'private', stderr: 'private stderr' },
    } }).success).toBe(false);
  });

  it('keeps an opaque preset setup source as a reference until the target receives its one-recipient projection', () => {
    const input = {
      homeId: 'home', machineId: 'managed', mode: 'check' as const,
      sources: [
        { kind: 'direct' as const, setup: {} },
        { kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 3, contentEncryptionMode: 'plain' as const },
      ],
    };
    expect(MachineSetupPlanInputV1Schema.parse(input)).toMatchObject(input);
    expect(MachineSetupPlanInputV1Schema.safeParse({ ...input, sources: [
      input.sources[0], { kind: 'accountPresetOpaque', presetId: 'preset', presetRevision: 3 },
    ] }).success).toBe(false);
    expect(MachineSetupPlanInputV1Schema.safeParse({ ...input, sources: [
      input.sources[0], { ...input.sources[1], setup: { setupScript: 'private' } },
    ] }).success).toBe(false);
    expect(MachineSetupPlanInputV1Schema.safeParse({ ...input, sources: [
      input.sources[0], { kind: 'accountPreset', presetId: 'preset', presetRevision: 3, setup: { setupScript: 'private' } },
    ] }).success).toBe(false);
    expect(MachineSetupResolveResultV1Schema.parse({ sources: [
      input.sources[0], { ...input.sources[1], presetContent: readerProjection },
    ] })).toMatchObject({ sources: [input.sources[0], { ...input.sources[1], presetContent: readerProjection }] });
  });

  it('carries the exact resolved source projection beside a setup Plan without making it an Apply operand', () => {
    const sources = [
      { kind: 'direct' as const, setup: {} },
      { kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 3, contentEncryptionMode: 'plain' as const },
    ];
    const result = {
      desiredRevision: 0,
      sources,
      resolvedSources: [
        sources[0],
        { ...sources[1], presetContent: readerProjection },
      ],
      exclusions: [],
      support: [],
      recipePlans: [],
    };
    const parsed = MachineSetupPlanResultV1Schema.parse(result);
    expect(parsed).toMatchObject(result);
    expect(machineSetupApplyTargetFromPlanV1({ homeId: 'home', machineId: 'managed' }, parsed))
      .not.toHaveProperty('resolvedSources');
    expect(MachineSetupPlanResultV1Schema.parse({ ...result,
      resolvedSources: [result.resolvedSources[0], null],
    }).resolvedSources).toEqual([sources[0], null]);
    expect(MachineSetupPlanResultV1Schema.safeParse({ ...result,
      resolvedSources: [null, result.resolvedSources[1]],
    }).success).toBe(false);
    expect(MachineSetupPlanResultV1Schema.safeParse({ ...result,
      resolvedSources: [result.resolvedSources[0]],
    }).success).toBe(false);
    expect(MachineSetupPlanResultV1Schema.safeParse({ ...result,
      resolvedSources: [result.resolvedSources[0], {
        ...result.resolvedSources[1], presetRevision: 4,
      }],
    }).success).toBe(false);
  });
});
