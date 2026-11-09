import { describe, expect, expectTypeOf, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import type { ActionSpec } from './actionSpecs.js';
import { ActionInputOptionSchema } from './actionInputHints.js';
import { normalizeActionInputByFieldHints, readActionSecretInputAdmission, readActionSecretInputPaths, resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';
import { InputHintsSchema, normalizeInputByFieldHints, resolveEffectiveInputFields } from '../inputs/index.js';
import { readInputPath, writeInputPath } from '../inputs/index.js';
import { projectInputOptionsDependencies } from '../inputs/inputOptionsDependencies.js';

describe('resolveEffectiveActionInputFields', () => {
  it('requests only required missing secrets while retaining optional and hidden supplied secrets for private custody', () => {
    const spec = { inputHints: { fields: [
      { path: 'required', title: 'Required', widget: 'secret', required: true },
      { path: 'optional', title: 'Optional', widget: 'secret' },
      { path: 'hidden', title: 'Hidden', widget: 'secret', visibleWhen: { op: 'truthy', path: 'showHidden' } },
    ] } } satisfies Parameters<typeof readActionSecretInputAdmission>[0];
    expect(readActionSecretInputAdmission(spec, { hidden: 'private' })).toEqual({
      paths: ['required', 'hidden'], missingPaths: ['required'],
    });
    expect(readActionSecretInputAdmission(spec, { required: 'private', optional: 'private' })).toEqual({
      paths: ['required', 'optional'], missingPaths: [],
    });
    expect(readActionSecretInputPaths(spec, {}, { includeInactive: true })).toEqual(['required', 'optional', 'hidden']);
  });

  it('retains contributed Action partial inputs without a host-owned provider key shortlist', () => {
    const draft = { credentialPrincipal: { kind: 'account', accountId: 'owner' },
      credentialRef: { opaque: 'saved-ref' }, providerIdentity: { providerAccountId: 'team' }, product: 'pages',
      arbitraryProviderChoice: { region: 'eu' } };
    expect(projectInputOptionsDependencies(draft, undefined, 'com.acme.deploy/actions/inspect')).toEqual(draft);
  });
  it('keeps Software option dependencies on the first reviewed target identity only', () => {
    const target = { homeId: 'target-home', machineId: 'first', setup: { scripts: [{ body: 'private script' }] } };
    const draft = { homeId: 'host-home', machineId: 'host', targets: [target, { ...target, machineId: 'second' }] };
    const expected = { homeId: draft.homeId, machineId: draft.machineId,
      targets: [{ homeId: target.homeId, machineId: target.machineId }] };
    expect(projectInputOptionsDependencies(draft)).toEqual(expected);
    expect(projectInputOptionsDependencies({ ...draft, targets: [{ ...target, setup: {} },
      { ...target, machineId: 'unrelated' }] })).toEqual(expected);
    expect(projectInputOptionsDependencies({ ...draft, targets: [{ ...target, machineId: 'changed' }] }))
      .toEqual({ ...expected, targets: [{ homeId: target.homeId, machineId: 'changed' }] });
  });
  it.each(['machines.setup.plan', 'machines.setup.apply'] as const)(
    'offers Software only for a prepared software slot in %s', actionId => {
      const spec = getActionSpec(actionId);
      for (const setup of [{}, { items: [{ kind: 'app' }] }, { items: [{ kind: 'setupRecipe' }] }]) {
        const sources = [{ kind: 'direct', setup }];
        const target = { homeId: 'home', machineId: 'target', sources };
        for (const input of [{}, actionId === 'machines.setup.plan' ? target : { targets: [target] }]) {
          expect(resolveEffectiveActionInputFields(spec, input)
            .some(field => field.optionsSourceId === 'machines.setup.software.available')).toBe(false);
        }
      }
    },
  );
  it.each(['machines.setup.plan', 'machines.setup.apply'] as const)(
    'preserves prepared setup arrays when choosing Software for %s', actionId => {
      const ref = { pluginId: 'fixture.software', recipeId: 'fonts', revision: '1' };
      const replacement = { ...ref, recipeId: 'ffmpeg' };
      const item = { kind: 'softwareRecipe', selection: { ref, inputs: {} } };
      const sources = [{ kind: 'direct', setup: { items: [item, item] } },
        { kind: 'accountPreset', presetId: 'retained', presetRevision: 1, setup: {} }];
      const first = { homeId: 'home', machineId: 'first', desiredRevision: 0, recipePlans: [], sources };
      const second = { ...first, machineId: 'second' };
      const input = actionId === 'machines.setup.plan' ? { homeId: 'home', machineId: 'first', sources }
        : { homeId: 'home', machineId: 'host', targets: [first, second] };
      const spec = getActionSpec(actionId);
      const field = resolveEffectiveActionInputFields(spec, input)
        .find(candidate => candidate.optionsSourceId === 'machines.setup.software.available');
      if (!field) throw new Error('Expected the Software choice');
      const changed = writeInputPath(input, field.path, replacement);
      expect(spec.inputSchema.safeParse(changed).success).toBe(true);
      expect(readInputPath(changed, field.path)).toEqual(replacement);
      expect(readInputPath(input, actionId === 'machines.setup.plan'
        ? 'sources.0.setup.items.0.selection.ref' : 'targets.0.sources.0.setup.items.0.selection.ref')).toBe(ref);
      const changedSources = readInputPath(changed, actionId === 'machines.setup.plan' ? 'sources' : 'targets.0.sources');
      expect(Array.isArray(changedSources)).toBe(true);
      if (!Array.isArray(changedSources)) throw new Error('Expected source copies');
      expect(changedSources[1]).toBe(sources[1]);
      expect(readInputPath(changedSources, '0.setup.items.1')).toBe(item);
      if (actionId === 'machines.setup.apply') expect(readInputPath(changed, 'targets.1')).toBe(second);
      const other = writeInputPath({ targets: [first, second] }, 'targets.1.sources.0.setup.items.1.selection.ref', replacement);
      expect(readInputPath(other, 'targets.0')).toBe(first);
      expect(readInputPath(other, 'targets.1.sources.0.setup.items.0')).toBe(item);
      expect(readInputPath(other, 'targets.1.sources.0.setup.items.1.selection.ref')).toEqual(replacement);
      expect(Array.isArray(readInputPath(other, 'targets.1.sources.0.setup.items'))).toBe(true);
      const targets = [first, second];
      for (const index of ['-1', '01', '1e0', '[]', '4294967295']) {
        const unchanged = writeInputPath({ targets }, `targets.${index}.machineId`, 'invalid-index');
        expect(unchanged).toEqual({ targets });
        expect(unchanged.targets).toBe(targets);
      }
    },
  );
  it('lets every workflow-trigger list union arm be authored through the shared Action fields', () => {
    const spec = getActionSpec('workflow.trigger.list');
    const cases = [
      { workflow: 'builtin:keep-going' },
      { scope: 'account_all' },
      { scope: 'account_inline' },
      { automationId: 'automation-1', review: true },
    ];
    for (const input of cases) {
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      const fields = resolveEffectiveActionInputFields(spec, input);
      for (const key of Object.keys(input)) {
        expect(fields.find(field => field.path === key), key).toBeDefined();
      }
      for (const field of fields.filter(field => field.required)) {
        expect(input, field.path).toHaveProperty(field.path);
      }
    }
    expect(resolveEffectiveActionInputFields(spec, {}).find(field => field.path === 'workflow'))
      .toMatchObject({ required: true, optionsSourceId: 'workflows.references.available' });
    expect(resolveEffectiveActionInputFields(spec, { review: true }).find(field => field.path === 'automationId'))
      .toMatchObject({ required: true });
    expect(resolveEffectiveActionInputFields(getActionSpec('session.trigger.list'), {}))
      .toContainEqual(expect.objectContaining({ path: 'sessionId', required: true }));
  });
  it('uses the neutral field owner for structured selections and conditional fields', () => {
    const a = { service: { pluginId: 'com.acme.accounts', localId: 'service' }, accountId: 'a' };
    const b = { ...a, accountId: 'b' };
    const spec = { inputHints: InputHintsSchema.parse({ fields: [
      { path: 'accounts', title: 'Accounts', widget: 'multiselect', maxSelections: 1,
        options: [{ value: a, label: 'A' }, { value: b, label: 'B' }] },
      { path: 'note', title: 'Note', widget: 'text', visibleWhen: { op: 'truthy', path: 'show' } },
    ] }) };
    const input = { accounts: [a, b], show: false, note: 'Retained' };
    expect(normalizeActionInputByFieldHints(spec, input)).toEqual(normalizeInputByFieldHints(spec, input));
    expect(normalizeInputByFieldHints(spec, input)).toEqual({ ...input, accounts: [b] });
    expect(resolveEffectiveActionInputFields(spec, input)).toEqual(resolveEffectiveInputFields(spec, input));
    expect(resolveEffectiveInputFields(spec, input).map((field) => field.path)).toEqual(['accounts']);
    expect(input.accounts).toEqual([a, b]);
  });
  it('offers the required scalar value editor and optional page filter for declared settings Actions', () => {
    const setFields = resolveEffectiveActionInputFields(getActionSpec('settings.set'), { anchor: 'appearance.density' });
    expect(setFields.find((field) => field.path === 'value')).toMatchObject({ widget: 'json', required: true, visible: true });
    const listFields = resolveEffectiveActionInputFields(getActionSpec('settings.list'), {});
    expect(listFields.find((field) => field.path === 'pageId')).toMatchObject({ widget: 'text', required: false, visible: true });
  });

  it('accepts the exact input-hints owner rather than requiring a fabricated ActionSpec', () => {
    expectTypeOf<Parameters<typeof resolveEffectiveActionInputFields>[0]>()
      .toEqualTypeOf<Pick<ActionSpec, 'inputHints'>>();
    expectTypeOf<Parameters<typeof normalizeActionInputByFieldHints>[0]>()
      .toEqualTypeOf<Pick<ActionSpec, 'inputHints'>>();

    const hintsOnly = {
      inputHints: {
        fields: [{ path: 'kind', title: 'Kind', widget: 'text' }],
      },
    } satisfies Pick<ActionSpec, 'inputHints'>;

    expect(resolveEffectiveActionInputFields(hintsOnly, {}).map((field) => field.path)).toEqual(['kind']);
    expect(normalizeActionInputByFieldHints(hintsOnly, { kind: 'review' })).toEqual({ kind: 'review' });
  });

  it('hides conditional base fields for review.start based on base.kind', () => {
    const spec = getActionSpec('review.start');

    const none = resolveEffectiveActionInputFields(spec, {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: { kind: 'none' },
    });
    expect(none.map((f) => f.path)).not.toContain('base.baseBranch');
    expect(none.map((f) => f.path)).not.toContain('base.baseCommit');

    const branch = resolveEffectiveActionInputFields(spec, {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: { kind: 'branch', baseBranch: 'main' },
    });
    expect(branch.map((f) => f.path)).toContain('base.baseBranch');
    expect(branch.map((f) => f.path)).not.toContain('base.baseCommit');
    expect(branch.find((f) => f.path === 'base.baseBranch')?.required).toBe(true);

    const commit = resolveEffectiveActionInputFields(spec, {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: { kind: 'commit', baseCommit: 'abc123' },
    });
    expect(commit.map((f) => f.path)).not.toContain('base.baseBranch');
    expect(commit.map((f) => f.path)).toContain('base.baseCommit');
    expect(commit.find((f) => f.path === 'base.baseCommit')?.required).toBe(true);
  });

  it('retains schema-admitted inactive draft values without converting omission and null', () => {
    const spec = getActionSpec('review.start');
    const input = {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: {
        kind: 'none',
        baseBranch: 'main',
        baseCommit: null,
      },
    };

    expect(resolveEffectiveActionInputFields(spec, input).map((field) => field.path)).not.toContain('base.baseBranch');
    expect(resolveEffectiveActionInputFields(spec, input).map((field) => field.path)).not.toContain('base.baseCommit');
    expect(normalizeActionInputByFieldHints(spec, input)).toEqual(input);
  });

  it('normalizes multiselect fields using protocol-owned field limits', () => {
    const spec = getActionSpec('subagents.plan.start');

    expect(normalizeActionInputByFieldHints(spec, {
      sessionId: 'session-1',
      backendTargetKeys: ['agent:claude', 'agent:opencode'],
      instructions: 'Plan this.',
    })).toEqual({
      sessionId: 'session-1',
      backendTargetKeys: ['agent:opencode'],
      instructions: 'Plan this.',
    });
  });

  it('accepts exact qualified Connected Account refs in host-resolved options', () => {
    const account = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: 'account-1',
    };

    expect(ActionInputOptionSchema.parse({
      value: account,
      label: 'Work account',
    }).value).toEqual(account);
  });
});
