import { describe, expect, it, vi } from 'vitest';

const targetKeyBuilds = vi.hoisted(() => ({ count: 0 }));
// Observation only: the real builder still runs; the count shows how often validation asks for it.
vi.mock('../backends/targets/backendTargetRefV2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backends/targets/backendTargetRefV2.js')>();
  return { ...actual, buildBackendTargetKeyV2: (...args: Parameters<typeof actual.buildBackendTargetKeyV2>) => {
    targetKeyBuilds.count += 1;
    return actual.buildBackendTargetKeyV2(...args);
  } };
});

const { validateWorkflowDefinition } = await import('./workflowValidationV1.js');

const AGENT = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const draft = (steps: number) => ({
  version: 1, inputs: [], defaults: { agentTarget: AGENT },
  blocks: Array.from({ length: steps }, (_unused, index) => ({
    kind: 'step', id: `b${index}`, input: [], result: { kind: 'text' },
    document: { text: `Check b${index}`, references: [], attachments: [] },
  })),
});

describe('workflow validation cost', () => {
  it('does not re-resolve the shared Agent default for every step', () => {
    const buildsFor = (steps: number) => {
      targetKeyBuilds.count = 0;
      const result = validateWorkflowDefinition(draft(steps));
      expect(result.valid).toBe(true);
      return targetKeyBuilds.count;
    };
    buildsFor(2);
    expect(buildsFor(200)).toBe(buildsFor(2));
  });
});
