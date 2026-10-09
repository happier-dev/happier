import { describe, expect, it } from 'vitest';

import {
  compareWorkspaceWorkerPreferenceMutationV1,
  resolveProjectExecutionChoiceV1 as resolve,
  WorkspaceExecutionSettingsV1StoredSchema,
  WorkspaceWorkerPreferenceV1Schema,
  type WorkspaceExecutionSettingsV1,
  type WorkspaceWorkerPreferenceV1,
} from './index.js';

const preference = {
  enabled: true,
  destination: { kind: 'pool', poolId: '4e9648b6-6b2d-47dc-9e3f-d927a430102d', selection: 'automatic' },
  unavailable: 'ask', allowAdHoc: false, scriptOverrides: {},
} as const;

describe('workspace worker preference authority', () => {
  it('requires an enabled destination and keeps tolerant stored reads separate from strict input', () => {
    expect(WorkspaceWorkerPreferenceV1Schema.safeParse({ ...preference, destination: undefined })).toMatchObject({ success: false });
    expect(WorkspaceWorkerPreferenceV1Schema.safeParse({ ...preference, services: {} })).toMatchObject({ success: false });
    expect(WorkspaceExecutionSettingsV1StoredSchema.parse({ ...preference, services: {}, extra: true,
      destination: { ...preference.destination, extra: true } }))
      .toEqual({ ...preference, services: {} });
  });

  it('preserves exact declaration names instead of merging distinct script or service keys', () => {
    const value = { ...preference, scriptOverrides: { test: 'primary' as const, ' test ': 'workers' as const },
      services: { web: { runsOn: { kind: 'primary' as const }, unavailable: 'fail' as const },
        ' web ': { runsOn: { kind: 'primary' as const }, unavailable: 'primary' as const } } };
    expect(WorkspaceExecutionSettingsV1StoredSchema.parse(value)).toEqual(value);
  });

  it('keeps primary-only declarations on primary even with an explicit worker choice', () => {
    expect(resolve({ execution: 'primary', invocation: { kind: 'workers', destination: { kind: 'machine', machineId: 'other' } },
      preference: { status: 'ready', value: preference }, scriptName: 'test' }))
      .toEqual({ status: 'refused', reason: 'primary_only' });
  });

  it('preserves the accepted Workflow Machine instead of silently using workspace Auto', () => {
    expect(resolve({ execution: 'portable', scriptName: 'test', acceptedMachineId: 'accepted',
      preference: { status: 'ready', value: preference } }))
      .toEqual({ status: 'resolved', choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'accepted' } }, provenance: 'workflow' });
  });

  it('refuses an implicit accepted worker for a primary-only declaration without silently rerouting the Workflow', () => {
    const input = { execution: 'primary' as const, sourceMachineId: 'source', acceptedMachineId: 'worker',
      preference: { status: 'ready' as const, value: preference } };
    expect(resolve(input)).toEqual({ status: 'refused', reason: 'primary_only' });
    expect(resolve({ ...input, acceptedMachineId: 'source' }))
      .toEqual({ status: 'resolved', choice: { kind: 'primary' }, provenance: 'declaration' });
    expect(resolve({ ...input, reviewedOverride: true, invocation: { kind: 'primary' } }))
      .toEqual({ status: 'resolved', choice: { kind: 'primary' }, provenance: 'declaration' });
  });

  it('classifies the frozen Workflow baseline against the admitted source, without granting a target override', () => {
    const source = { execution: 'portable' as const, scriptName: 'test', sourceMachineId: 'source',
      preference: { status: 'ready' as const, value: preference } };
    const primary = { ...source, acceptedMachineId: 'source' };
    expect(resolve(primary)).toEqual({ status: 'resolved', choice: { kind: 'primary' }, provenance: 'workflow' });
    expect(resolve({ ...primary, invocation: { kind: 'primary' } }))
      .toEqual({ status: 'resolved', choice: { kind: 'primary' }, provenance: 'workflow' });
    const worker = { ...source, acceptedMachineId: 'accepted' };
    const accepted = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'accepted' } };
    expect(resolve(worker)).toEqual({ status: 'resolved', choice: accepted, provenance: 'workflow' });
    expect(resolve({ ...worker, invocation: accepted }))
      .toEqual({ status: 'resolved', choice: accepted, provenance: 'workflow' });
    expect(resolve({ ...worker, invocation: { kind: 'primary' } }))
      .toEqual({ status: 'refused', reason: 'override_requires_review' });
    expect(resolve({ ...primary, invocation: accepted }))
      .toEqual({ status: 'refused', reason: 'override_requires_review' });
  });

  it('does not turn unavailable preferences into default primary permission', () => {
    expect(resolve({ execution: 'portable', scriptName: 'test', preference: { status: 'unavailable' } }))
      .toEqual({ status: 'refused', reason: 'preferences_unavailable' });
  });

  it('rebases a finite-only edit over a concurrent service change and conflicts on the same preference', () => {
    const current = { ...preference, services: { web: { runsOn: { kind: 'primary' }, unavailable: 'fail' } } } satisfies WorkspaceExecutionSettingsV1;
    const next = { ...preference, unavailable: 'fail' } satisfies WorkspaceWorkerPreferenceV1;
    const result = compareWorkspaceWorkerPreferenceMutationV1({ current, expected: { kind: 'value', value: preference }, next });
    expect(result).toEqual({ status: 'apply', value: { ...next, services: current.services } });
    const conflict = compareWorkspaceWorkerPreferenceMutationV1({ current: { ...current, allowAdHoc: true },
      expected: { kind: 'value', value: preference }, next });
    expect(conflict).toMatchObject({ status: 'conflict' });
    expect(compareWorkspaceWorkerPreferenceMutationV1({ current, expected: { kind: 'value', value: preference }, next: null }))
      .toEqual({ status: 'apply', value: { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: current.services } });
  });

  it('treats an absent finite expectation as the unchanged default when a service created the row first', () => {
    const current = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {},
      services: { web: { runsOn: { kind: 'primary' }, unavailable: 'primary' } } } satisfies WorkspaceExecutionSettingsV1;
    const next = { ...preference, allowAdHoc: true };
    expect(compareWorkspaceWorkerPreferenceMutationV1({ current, expected: { kind: 'absent' }, next }))
      .toEqual({ status: 'apply', value: { ...next, services: current.services } });
    expect(compareWorkspaceWorkerPreferenceMutationV1({ current: { ...current, allowAdHoc: true }, expected: { kind: 'absent' }, next }))
      .toMatchObject({ status: 'conflict' });
  });

  it('uses invocation, script and workspace precedence only after eligibility and ad-hoc opt-in', () => {
    const saved = { ...preference, scriptOverrides: { test: 'primary' as const } };
    const base = { execution: 'portable' as const, scriptName: 'test', preference: { status: 'ready' as const, value: saved } };
    expect(resolve(base)).toEqual({ status: 'resolved', choice: { kind: 'primary' }, provenance: 'script' });
    expect(resolve({ ...base, invocation: { kind: 'workers', destination: { kind: 'machine', machineId: 'exact' } } }))
      .toEqual({ status: 'resolved', choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'exact' } }, provenance: 'invocation' });
    expect(resolve({ ...base, adHoc: true })).toEqual({ status: 'refused', reason: 'ad_hoc_disabled' });
    expect(resolve({ ...base, acceptedMachineId: 'baseline', invocation: { kind: 'primary' } }))
      .toEqual({ status: 'refused', reason: 'override_requires_review' });
    expect(resolve({ ...base, acceptedMachineId: 'baseline', reviewedOverride: true, invocation: { kind: 'primary' } }))
      .toEqual({ status: 'resolved', choice: { kind: 'primary' }, provenance: 'invocation' });
  });
});
