import { describe, expect, it, vi } from 'vitest';

import { parseWorkflowDocumentV1, validateWorkflowDefinition, type WorkflowDefinitionGetResultV1 } from '@happier-dev/protocol';
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
  it('imports strict JSON from stdin through workflow.definition.create', async () => {
    const harness = actionHarness((_actionId, input) => input);
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: [
          'workflow', 'definition', 'import', '-',
          '--definition-id', 'workflow-definition-1',
          '--metadata-json', '{"title":"Review workflow"}',
          '--json',
        ],
        readStdinFn: async () => JSON.stringify(DOCUMENT),
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.execute).toHaveBeenCalledWith(
        'workflow.definition.create',
        {
          definitionId: 'workflow-definition-1',
          definition: DOCUMENT.definition,
          metadata: { title: 'Review workflow' },
        },
        expect.objectContaining({ surface: 'cli' }),
      );
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'workflow_definition_create',
      });
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('normalizes an ingress-dialect document before workflow.definition.create', async () => {
    const harness = actionHarness((_actionId, input) => input);
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: [
          'workflow', 'definition', 'import', '-',
          '--definition-id', 'workflow-definition-1',
          '--metadata-json', '{"title":"Review workflow"}',
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
        'workflow.definition.create',
        {
          definitionId: 'workflow-definition-1',
          definition: DOCUMENT.definition,
          metadata: { title: 'Review workflow' },
        },
        expect.objectContaining({ surface: 'cli' }),
      );
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('exports the exact portable wrapper from workflow.definition.get to stdout', async () => {
    const harness = actionHarness(() => ({
      definitionId: 'workflow-definition-1',
      revision: { headerVersion: 2, bodyVersion: 3 },
      definition: DOCUMENT.definition,
      metadata: { title: 'Review workflow' },
      access: 'owner',
    } satisfies WorkflowDefinitionGetResultV1));
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: ['workflow', 'definition', 'export', 'workflow-definition-1'],
        readStdinFn: async () => '',
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).toHaveBeenCalledOnce();
      expect(harness.execute).toHaveBeenCalledWith(
        'workflow.definition.get',
        { definitionId: 'workflow-definition-1' },
        expect.objectContaining({ surface: 'cli' }),
      );
      expect(output.json()).toEqual(DOCUMENT);
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });

  it('preserves the file when a future document version is unsupported and invokes no Action', async () => {
    const harness = actionHarness(() => ({ ok: true }));
    const output = captureStdoutJsonOutput();
    try {
      expect(await tryHandleWorkflowDocumentCliCommand({
        argv: [
          'workflow', 'definition', 'import', 'future.json',
          '--definition-id', 'workflow-definition-1',
          '--metadata-json', '{"title":"Future"}',
          '--json',
        ],
        readFileFn: async () => JSON.stringify({ ...DOCUMENT, version: 2 }),
        readStdinFn: async () => '',
        actionExecutionDeps: harness.deps as never,
      })).toBe(true);

      expect(harness.execute).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'workflow_definition_import',
        error: { code: 'unsupported_workflow_document_version', version: 2 },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = undefined;
    }
  });
});
