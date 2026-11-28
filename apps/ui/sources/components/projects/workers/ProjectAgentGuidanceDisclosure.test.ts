import { describe, expect, it, vi } from 'vitest';
import {
  formatProjectComputeAgentGuidanceV1,
  PROJECT_COMPUTE_EXEC_CLI_USAGE,
  PROJECT_SCRIPT_RUN_CLI_USAGE,
} from '@happier-dev/protocol/workspaces/projectAgentGuidanceV1';
import { createDefaultWorkspaceWorkerPreferenceV1, resolveProjectExecutionChoiceV1, type WorkspaceWorkerPreferenceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, options) => options ? `${key} ${JSON.stringify(options)}` : key,
  }),
);

const { describeProjectAgentGuidance } =
  await import('./ProjectAgentGuidanceDisclosure');
type Guidance = Parameters<typeof describeProjectAgentGuidance>[0];

function guidance(adHoc: 'resolved' | 'refused'): Guidance {
  const preference = { ...createDefaultWorkspaceWorkerPreferenceV1(), allowAdHoc: adHoc === 'resolved' };
  const resolve = (execution: 'portable' | 'primary', scriptName?: string) => resolveProjectExecutionChoiceV1({
    execution, ...(scriptName ? { scriptName } : { adHoc: true }), preference: { status: 'ready', value: preference },
  });
  return {
    advisory: true,
    sourceWorkspace: { serverId: 'home', workspaceId: 'source', machineId: 'primary', rootPath: '/repo' },
    definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, status: 'valid', diagnostics: [] },
    workerPreferences: { status: 'ready', preference, revision: 'absent', provenance: 'default' },
    destination: null,
    services: [],
    scripts: [
      { name: 'test', source: { kind: 'command', command: 'test' }, execution: 'portable', resolution: resolve('portable', 'test') },
      { name: 'typecheck', source: { kind: 'command', command: 'typecheck' }, execution: 'portable', resolution: resolve('portable', 'typecheck') },
      { name: 'lint', source: { kind: 'command', command: 'lint' }, execution: 'primary', resolution: resolve('primary', 'lint') },
    ],
    adHoc: {
      actionId: 'projects.compute.exec', approval: 'configured_action_policy', resolution: resolve('portable'),
    },
  };
}

describe('describeProjectAgentGuidance', () => {
  it('renders portable scripts through the single canonical formatter and lists primary scripts separately without duplication', () => {
    const text = describeProjectAgentGuidance(guidance('refused'), 'happier');
    const lines = text.split('\n');
    expect(
      lines.find((line) => line.startsWith('Portable scripts')),
    ).toContain('"test", "typecheck"');
    expect(
      lines.find((line) => line.includes('projectWorkers.guidePrimary')),
    ).toContain('lint');
    expect(
      lines.find((line) => line.startsWith('Portable scripts')),
    ).not.toContain('lint');
    // CLI usage appears once (via canonical formatter), never duplicated.
    expect(text.split(PROJECT_SCRIPT_RUN_CLI_USAGE).length - 1).toBe(1);
    expect(text).not.toContain(PROJECT_COMPUTE_EXEC_CLI_USAGE);
  });

  it('says whether explicit ad-hoc commands are allowed from the resolved checkout preference', () => {
    expect(
      describeProjectAgentGuidance(guidance('refused'), 'happier'),
    ).toContain('projectWorkers.guideAdHocOff');
    const allowedText = describeProjectAgentGuidance(guidance('resolved'), 'happier');
    expect(allowedText).toContain(PROJECT_COMPUTE_EXEC_CLI_USAGE);
    expect(allowedText.split(PROJECT_COMPUTE_EXEC_CLI_USAGE).length - 1).toBe(1);
  });

  it.each(['locked', 'unavailable'] as const)('does not describe %s reads as an empty project or ad-hoc opt-out', status => {
    const facts: Guidance = { ...guidance('refused'), scripts: null,
      definition: { ok: false, errorCode: 'unavailable', error: 'unavailable' },
      workerPreferences: { status }, destination: { status },
      adHoc: { actionId: 'projects.compute.exec', approval: 'configured_action_policy',
        resolution: resolveProjectExecutionChoiceV1({ execution: 'portable', adHoc: true, preference: { status } }) } };
    const text = describeProjectAgentGuidance(facts, 'happier');
    expect(text).not.toContain('projectWorkers.guideNoScripts');
    expect(text).not.toContain('projectWorkers.guideAdHocOff');
    expect(text).toContain('projectWorkers.guideUnavailable');
    expect(text).toContain('projectWorkers.policyUnavailable');
  });

  it('states the default target once instead of once per script', () => {
    const text = describeProjectAgentGuidance(guidance('refused'), 'happier');
    expect(text.match(/projectWorkers\.defaultSummary/g)?.length).toBe(1);
    expect(text).not.toMatch(/^(test|typecheck|lint): /m);
  });

  it.each(['primaryFirst', 'portableFirst', 'allOverridden', 'noScripts'] as const)(
    'describes the workspace default independently of declaration order and overrides (%s)', order => {
      const base = guidance('refused');
      const preference: WorkspaceWorkerPreferenceV1 = { ...createDefaultWorkspaceWorkerPreferenceV1(), enabled: true as const,
        destination: { kind: 'machine' as const, machineId: 'worker-b' },
        scriptOverrides: order === 'allOverridden' ? { test: 'primary' as const, typecheck: 'primary' as const, lint: 'primary' as const } : {} };
      const scripts = base.scripts!.map(script => ({ ...script, resolution: resolveProjectExecutionChoiceV1({
        execution: script.execution, scriptName: script.name, preference: { status: 'ready', value: preference },
      }) }));
      if (order === 'primaryFirst') scripts.reverse();
      if (order === 'noScripts') scripts.length = 0;
      const text = describeProjectAgentGuidance({ ...base, scripts,
        workerPreferences: { status: 'ready', preference, revision: 1, provenance: 'saved' } }, 'happier');
      expect(text.split('\n').filter(line => line.startsWith('projectWorkers.defaultSummary')))
        .toEqual(['projectWorkers.defaultSummary {"destination":"worker-b"}']);
      if (order !== 'noScripts') expect(text.split('\n').find(line => line.includes('projectWorkers.guidePrimary'))).toContain('lint');
      if (order === 'allOverridden') expect(text).toContain('test: projectWorkers.primary');
    },
  );

  it('describes the disabled workspace default even without Scripts', () => {
    const base = guidance('refused');
    const preference = createDefaultWorkspaceWorkerPreferenceV1();
    const text = describeProjectAgentGuidance({ ...base, scripts: [],
      workerPreferences: { status: 'ready', preference, revision: 1, provenance: 'saved' } }, 'happier');
    expect(text.split('\n').filter(line => line.startsWith('projectWorkers.defaultSummary')))
      .toEqual(['projectWorkers.defaultSummary {"destination":"projectWorkers.primary"}']);
  });

  it('distinguishes actual empty declarations from an unavailable read', () => {
    expect(describeProjectAgentGuidance({ ...guidance('refused'), scripts: [] }, 'happier'))
      .toContain('projectWorkers.guideNoScripts');
  });

  it('passes workerSummary into the single canonical prompt block and avoids duplicating scripts, destination, or CLI commands', () => {
    const base = guidance('resolved');
    const destination = { kind: 'machine', machineId: 'worker-b' } as const;
    const preference = { ...createDefaultWorkspaceWorkerPreferenceV1(), enabled: true, allowAdHoc: true,
      destination, scriptOverrides: { test: 'workers' } } as const;
    const facts: Guidance = { ...base,
      workerPreferences: { status: 'ready', preference, revision: 1, provenance: 'saved' },
      scripts: base.scripts!.map(script => ({ ...script, resolution: resolveProjectExecutionChoiceV1({
        execution: script.execution, scriptName: script.name, sourceMachineId: base.sourceWorkspace.machineId,
        preference: { status: 'ready', value: preference },
      }) })),
      adHoc: { ...base.adHoc, resolution: resolveProjectExecutionChoiceV1({ execution: 'portable', adHoc: true,
        preference: { status: 'ready', value: preference } }) },
      destination: { configured: destination, observation: { eligible: false, load: { kind: 'unknown' }, candidate: null,
        explanation: 'not_accepting', lastCleanSyncAtMs: null } } };
    const text = describeProjectAgentGuidance(facts, 'happier');
    expect(text).toContain('worker-b');
    expect(text.match(/projectWorkers\.defaultSummary \{"destination":"[^"]*"\}/g)?.length).toBe(1);
    expect(text).toContain('test: worker-b');
    expect(text).not.toContain('typecheck: ');
    expect(text).not.toContain('lint: ');
    expect(text).toContain('projectWorkers.notAccepting');
    expect(text).toContain('projectWorkers.notAcceptingDetail');
    // Neither CLI usage string is duplicated.
    expect(text.split(PROJECT_SCRIPT_RUN_CLI_USAGE).length - 1).toBe(1);
    expect(text.split(PROJECT_COMPUTE_EXEC_CLI_USAGE).length - 1).toBe(1);
    const canonical = formatProjectComputeAgentGuidanceV1({
      workspace: base.sourceWorkspace,
      portableScripts: [{ name: 'test' }, { name: 'typecheck' }],
      workerPreferences: {
        enabled: true,
        allowAdHoc: true,
        destinationLabel: 'worker-b',
        unavailable: preference.unavailable,
      },
      workerSummary: 'projectWorkers.notAccepting',
    });
    expect(canonical).not.toBeNull();
    expect(text).toContain(canonical!.promptBlock);
  });

  it('omits the canonical session prompt block when neither portable scripts nor enabled workers exist', () => {
    const base = guidance('refused');
    const text = describeProjectAgentGuidance({
      ...base,
      scripts: base.scripts!.filter((script) => script.execution !== 'portable'),
    }, 'happier');
    expect(text).not.toContain('projects_script_run');
    expect(text).not.toContain('projects_compute_exec');
    expect(text).not.toContain(PROJECT_SCRIPT_RUN_CLI_USAGE);
    expect(text).not.toContain(PROJECT_COMPUTE_EXEC_CLI_USAGE);
  });
});
