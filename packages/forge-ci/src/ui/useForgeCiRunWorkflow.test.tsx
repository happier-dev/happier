// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { ForgeCiActionInputSchemasV1, type ForgeCiOperationIdV1, type ForgeCiMutationResultV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { createForgeCiAdapterV1 } from '../runtime/adapter.js';
import { createForgeCiReadsV1 } from '../runtime/reads.js';
import { readForgeCiTriggerValuesV1, reconcileForgeCiTriggerDraftV1 } from '../runtime/triggerFields.js';
import { useForgeCiRunWorkflowV1 } from './useForgeCiRunWorkflow.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the shared selected-workflow controller', () => {
  it('publishes a dispatched run to the shared runs and workflow summary reads once, leaving unrelated queries alone', async () => {
    const native = createForgeCiConformanceVectorsV1().github;
    const repository = native.run.ref.repository;
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const previous = { ...native.run, workflow: { id: '42' }, state: { phase: 'completed', nativeLabel: 'completed', outcome: 'success', outcomeBucket: 'passed' } as const, ref: { ...native.run.ref, runId: '3' } };
    const next = { ...previous, ref: { ...previous.ref, runId: '4' } };
    let dispatched = false;
    const calls: JsonValue[] = [];
    const adapter = createForgeCiAdapterV1({ actionRefs, invoke: async (action, input) => {
      if (action.localId === 'listRuns') {
        calls.push(input);
        return { kind: 'value', value: { rows: [dispatched ? next : previous], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } };
      }
      if (action.localId === 'dispatchWorkflow') {
        dispatched = true;
        return { kind: 'confirmed', affected: { repository, workflowId: '42', ref: 'main', run: next.ref }, receipt: { id: '4' } };
      }
      return { kind: 'value', value: { workflowId: '42', ref: 'main', revision: 'a'.repeat(40), dispatchable: true, inputs: [] } };
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'dispatch-reads' });
    const runs = reads.acquirePaged('listRuns', { repository, filters: {} });
    const summary = reads.acquirePaged('listRuns', { repository, workflowId: '42', filters: {} });
    const otherWorkflow = reads.acquire('listRuns', { repository, workflowId: '43', filters: {} });
    const otherRepository = reads.acquire('listRuns', { repository: { ...repository, repository: 'other/repository' }, filters: {} });
    const otherBranch = reads.acquire('listRuns', { repository, filters: { branch: 'other' } });
    let fixture: PluginUiTestkit | undefined;
    let model!: ReturnType<typeof useForgeCiRunWorkflowV1>;
    function Body() {
      model = useForgeCiRunWorkflowV1({ ci: { reads, adapter, actionRefs, about: { forgeName: 'GitHub' }, account: null }, repository, workflowId: '42', initialRef: 'main', onStarted: () => {} });
      return <Text value={model.current?.ref ?? 'loading'} />;
    }
    try {
      await Promise.all([runs.refresh(), summary.refresh(), otherWorkflow.refresh(), otherRepository.refresh(), otherBranch.refresh()]);
      expect(runs.getValue()?.rows[0]?.ref.runId).toBe('3');
      expect(summary.getValue()?.rows[0]?.ref.runId).toBe('3');
      calls.length = 0;
      let publications = 0;
      runs.subscribeValue(() => { publications++; });
      await act(async () => { fixture = await createPluginUiTestkit({ identity: { instanceId: 'dispatch-reads', mountNonce: 'dispatch-reads' }, authorPlugin: { id: 'fixture.forge', version: '0.0.0' }, surface: defineUiSurface(() => <Body />), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter() }); });
      await fixture!.getByText('main');
      await act(async () => { await model.run({}); });
      expect(runs.getValue()?.rows[0]?.ref.runId).toBe('4');
      expect(summary.getValue()?.rows[0]?.ref.runId).toBe('4');
      expect(calls).toEqual([{ repository, filters: {} }, { repository, workflowId: '42', filters: {} }]);
      expect(publications).toBe(1);
    } finally {
      await act(async () => { await fixture?.dispose(); });
      reads.retire();
    }
  });
  it('admits repository environment choices on demand and exposes explicit continuation without rereading the definition', async () => {
    const repository = createForgeCiConformanceVectorsV1().github.run.ref.repository;
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const calls: { operation: string; input: unknown }[] = [];
    // Only the host Action transport is mocked; paging, leases and form admission are real.
    const adapter = createForgeCiAdapterV1({ actionRefs, invoke: async (action, input) => {
      calls.push({ operation: action.localId, input });
      if (action.localId === 'readTrigger') return { kind: 'value', value: { workflowId: '42', ref: 'main', revision: 'a'.repeat(40), dispatchable: true, inputs: [{ name: 'target', type: 'environment', required: true }] } };
      if (action.localId === 'listEnvironments') {
        const next = (input as { cursor?: string }).cursor !== undefined;
        return { kind: 'value', value: { rows: [{ id: next ? '2' : '1', name: next ? 'staging' : 'production' }], continuation: next ? null : 'next-env', incomplete: null, omittedRowCount: 0, projectionTruncated: false } };
      }
      throw new Error(`Unexpected operation ${action.localId}`);
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'account/environment-options' });
    let fixture: PluginUiTestkit | undefined;
    let model!: ReturnType<typeof useForgeCiRunWorkflowV1>;
    let setOpen!: React.Dispatch<React.SetStateAction<boolean>>;
    function Body() {
      const [formOpen, changeOpen] = React.useState(false);
      setOpen = changeOpen;
      model = useForgeCiRunWorkflowV1({ ci: { reads, adapter, actionRefs, about: { forgeName: 'GitHub' }, account: null }, repository, workflowId: '42', initialRef: 'main', formOpen, onStarted: () => {} });
      return <Text value={model.current?.ref ?? 'loading'} />;
    }
    try {
      await act(async () => { fixture = await createPluginUiTestkit({ identity: { instanceId: 'trigger-environments', mountNonce: 'trigger-environments' }, authorPlugin: { id: 'fixture.forge', version: '0.0.0' }, surface: defineUiSurface(() => <Body />), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter() }); });
      await fixture!.getByText('main');
      expect(calls.map(call => call.operation)).toEqual(['readTrigger']);
      await act(async () => { setOpen(true); });
      const choose = (target: string) => reconcileForgeCiTriggerDraftV1({ projection: model.draft!.projection, baseline: model.draft!, values: { target } });
      expect(readForgeCiTriggerValuesV1(choose('production'))).toEqual({ kind: 'value', value: { target: 'production' } });
      expect(calls.map(call => call.operation)).toEqual(['readTrigger', 'listEnvironments']);
      const firstField = model.draft!.projection.formHints.fields[0];
      await act(async () => { model.setDraft(choose('production')); });
      await act(async () => { await model.environmentsQuery?.loadMore(); });
      expect(model.draft?.values).toEqual({ target: 'production' });
      expect(model.draft?.projection.formHints.fields[0]?.path).toBe(firstField?.path);
      expect(model.draft?.projection.formHints.fields[0]?.options?.map(option => option.value)).toEqual(['production', 'staging']);
      expect(readForgeCiTriggerValuesV1(choose('staging'))).toEqual({ kind: 'value', value: { target: 'staging' } });
      expect(calls.map(call => call.operation)).toEqual(['readTrigger', 'listEnvironments', 'listEnvironments']);
      expect(calls[2]?.input).toMatchObject({ repository, cursor: 'next-env' });
      await act(async () => { model.setDraft(choose('staging')); setOpen(false); });
      expect(readForgeCiTriggerValuesV1(model.draft!)).toEqual({ kind: 'value', value: { target: 'staging' } });
      expect(calls.map(call => call.operation)).toEqual(['readTrigger', 'listEnvironments', 'listEnvironments']);
      await act(async () => { setOpen(true); });
      expect(readForgeCiTriggerValuesV1(model.draft!)).toEqual({ kind: 'value', value: { target: 'staging' } });
    } finally { await act(async () => { await fixture?.dispose(); }); reads.retire(); }
  });
  it('reads only the selected ref, sends one exact dispatch, and retains an accepted receipt without guessing a run', async () => {
    const repository = createForgeCiConformanceVectorsV1().github.run.ref.repository;
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const calls: { operation: string; input: unknown }[] = [];
    let resolve!: (result: ForgeCiMutationResultV1) => void;
    const receipt = new Promise<ForgeCiMutationResultV1>(done => { resolve = done; });
    const started: string[] = [];
    // Host Action transport is the only mocked boundary. Adapter, read leases and trigger projection are real.
    const adapter = createForgeCiAdapterV1({ actionRefs, invoke: async (action, input) => {
      calls.push({ operation: action.localId, input });
      if (action.localId === 'dispatchWorkflow') return receipt;
      const ref = (input as { ref: string }).ref;
      return { kind: 'value', value: { workflowId: '42', ref, revision: 'a'.repeat(40), dispatchable: true, inputs: [{ name: 'flag', type: 'boolean' }, { name: 'count', type: 'number' }] } };
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'account/credential/origin' });
    let fixture: PluginUiTestkit | undefined;
    let model!: ReturnType<typeof useForgeCiRunWorkflowV1>;
    function Body() {
      model = useForgeCiRunWorkflowV1({ ci: { reads, adapter, actionRefs, about: { forgeName: 'GitHub' }, account: null }, repository, workflowId: '42', initialRef: 'main', onStarted: id => started.push(id) });
      return <Text value={model.current?.ref ?? 'loading'} />;
    }
    try {
      await act(async () => { fixture = await createPluginUiTestkit({ identity: { instanceId: 'trigger-controller', mountNonce: 'trigger-controller' }, authorPlugin: { id: 'fixture.forge', version: '0.0.0' }, surface: defineUiSurface(() => <Body />), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter() }); });
      await fixture!.getByText('main');
      const originalDraft = model.draft;
      await act(async () => { model.setRef('release/current'); });
      await fixture!.getByText('release/current');
      expect(model.current?.ref).toBe('release/current');
      expect(model.draft?.projection.definition.ref).toBe('release/current');
      expect(model.draft?.projection.formHints).toBe(originalDraft?.projection.formHints);
      let first!: Promise<unknown>;
      await act(async () => { first = model.run({ flag: false, count: 0 }); void model.run({ flag: false, count: 0 }); });
      expect(calls.filter(call => call.operation === 'dispatchWorkflow')).toEqual([{ operation: 'dispatchWorkflow', input: { repository, workflowId: '42', ref: 'release/current', inputs: { flag: false, count: 0 } } }]);
      expect(model.sending).toBe(true);
      await act(async () => { model.setRef('after-submit'); });
      await fixture!.getByText('after-submit');
      await act(async () => { resolve({ kind: 'accepted', affected: { repository } }); await first; });
      expect(model.result).toEqual({ kind: 'accepted', affected: { repository } });
      expect(model.sending).toBe(false);
      expect(model).toMatchObject({ receipt: { input: { repository, workflowId: '42', ref: 'release/current', inputs: { flag: false, count: 0 } }, result: { kind: 'accepted' } } });
      expect(started).toEqual([]);
      expect(calls.filter(call => call.operation === 'readTrigger')).toHaveLength(3);
      expect(calls.every(call => call.operation === 'readTrigger' || call.operation === 'dispatchWorkflow')).toBe(true);
    } finally { await act(async () => { await fixture?.dispose(); }); reads.retire(); }
  });
});
