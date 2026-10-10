import { describe, expect, it, vi } from 'vitest';

import { parseWorkflowDocumentV1, validateWorkflowDefinition } from '@happier-dev/protocol';
import { parseWorkflowDocumentJsonIngressV1 } from '@happier-dev/protocol/workflows/workflowDocumentV1';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { tryHandleWorkflowDocumentCliCommand } from './workflowDocumentCommands';

/** Ingress dialect an agent or hand-written file may carry: prompt-only string blocks. */
const INGRESS_DEFINITION = {
  version: 1,
  defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
  },
  blocks: ['Summarize the current work'],
};

/** The canonical portable wrapper: the strict schema only accepts normalized definitions. */
const DOCUMENT = parseWorkflowDocumentV1({
  kind: 'happier.workflow',
  version: 1,
  definition: validateWorkflowDefinition(INGRESS_DEFINITION).normalizedDefinition,
});

function actionHarness(resultFor: (actionId: string, input: unknown) => unknown) {
  const execute = vi.fn(async (actionId: string, input: unknown) => ({
    ok: true as const,
    result: resultFor(actionId, input),
  }));
  return {
    execute,
    deps: {
      readCredentialsFn: async () => ({ token: 'hap_v1_test' } as never),
      createExecutorFn: () => ({
        resolveSessionTarget: async (sessionId: string) => ({ ok: true as const, sessionId }),
        execute,
      }),
    },
  };
}

describe('workflow document CLI commands', () => {
  it('imports stdin through the canonical unsaved document Action', async () => {
    const harness = actionHarness(() => ({ ok: true, classification: 'unsaved_definition', document: DOCUMENT }));
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: [
          'workflow', 'definition', 'import', '-',
          '--json',
        ],
        readStdinFn: async () => JSON.stringify(DOCUMENT),
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.execute).toHaveBeenCalledWith(
        'workflow.definition.import',
        { json: JSON.stringify(DOCUMENT) },
        expect.objectContaining({ surface: 'cli' }),
      );
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'workflow_definition_import',
        data: { classification: 'unsaved_definition', document: DOCUMENT },
      });
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('passes ingress JSON intact to the canonical import Action', async () => {
    const harness = actionHarness((_actionId, input) => input);
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: [
          'workflow', 'definition', 'import', '-',
          '--json',
        ],
        readStdinFn: async () => JSON.stringify({
          kind: 'happier.workflow',
          version: 1,
          definition: INGRESS_DEFINITION,
        }),
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.execute).toHaveBeenCalledWith(
        'workflow.definition.import',
        {
          json: JSON.stringify({ kind: 'happier.workflow', version: 1, definition: INGRESS_DEFINITION }),
        },
        expect.objectContaining({ surface: 'cli' }),
      );
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('exports the portable wrapper returned by the canonical export Action', async () => {
    const harness = actionHarness(() => ({
      definitionId: 'workflow-definition-1',
      revision: { headerVersion: 2, bodyVersion: 3 },
      document: DOCUMENT,
      json: JSON.stringify(DOCUMENT),
      metadata: { title: 'Review workflow' },
    }));
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: ['workflow', 'definition', 'export', 'workflow-definition-1'],
        readStdinFn: async () => '',
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.execute).toHaveBeenCalledWith(
        'workflow.definition.export',
        { definitionId: 'workflow-definition-1' },
        expect.objectContaining({ surface: 'cli' }),
      );
      expect(output.json()).toEqual(DOCUMENT);
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('preserves the file and reports the canonical unsupported document result', async () => {
    const harness = actionHarness(() => parseWorkflowDocumentJsonIngressV1(JSON.stringify({ ...DOCUMENT, version: 2 })));
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: [
          'workflow', 'definition', 'import', 'future.json',
          '--json',
        ],
        readFileFn: async () => JSON.stringify({ ...DOCUMENT, version: 2 }),
        readStdinFn: async () => '',
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'workflow_definition_import',
        error: { code: 'workflow_document_unsupported_version' },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });
});
