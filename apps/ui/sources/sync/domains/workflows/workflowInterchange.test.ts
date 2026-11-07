import { describe, expect, it } from 'vitest';

import type { WorkflowBlock, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import {
  WORKFLOW_EXPORT_PRIVACY_NOTE_KEY,
  exportWorkflowDefinition,
  exportWorkflowDocument,
  importWorkflowDocument,
} from './workflowInterchange';
import { createWorkflowEditorDraft, type WorkflowEditorDraft } from './workflowEditorDraft';
import { setWorkflowDefaultField } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { buildWorkflowDefinitionCandidate } from './workflowAuthoring';

const CLAUDE_AGENT_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function step(id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    kind: 'step',
    id,
    document: { text: `${id} prompt`, references: [], attachments: [] },
    input: [],
    result: { kind: 'text' },
    ...extra,
  };
}

function draftWith(blocks: readonly WorkflowBlock[], name = 'Review'): WorkflowEditorDraft {
  return setWorkflowDefaultField(
    createWorkflowEditorDraft({ draftId: 'draft-current', name, blocks }),
    'agentTarget',
    CLAUDE_AGENT_TARGET,
  );
}

/** A draft the author is in the middle of editing, which a failed import must not disturb. */
function openDraft(): WorkflowEditorDraft {
  return draftWith([step('keep-me')], 'Open work');
}

function documentJson(
  definition: unknown,
  envelope: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({ kind: 'happier.workflow', version: 1, definition, ...envelope });
}

function definitionWithDanglingReference(): unknown {
  return {
    version: 1,
    inputs: [],
    defaults: { agentTarget: CLAUDE_AGENT_TARGET },
    blocks: [
      step('analyze'),
      step('implement', {
        input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } }, path: [] }],
      }),
    ],
  };
}

describe('importWorkflowDocument', () => {
  it('serializes an opened frozen definition without reconstructing it from Run output', () => {
    const authored = exportWorkflowDocument({ draft: draftWith([step('analyze'), step('implement')]) });
    expect(authored.ok).toBe(true);
    if (!authored.ok) return;

    const frozen = exportWorkflowDefinition({ definition: authored.document.definition });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.document.definition).toEqual(authored.document.definition);
    expect(frozen.json).toBe(authored.json);
  });
  it('round-trips an exported document into a semantically identical definition', () => {
    const exported = exportWorkflowDocument({ draft: draftWith([step('analyze'), step('implement')]) });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const imported = importWorkflowDocument({
      source: exported.json,
      currentDraft: openDraft(),
      draftId: 'draft-imported',
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // Compared as normalized definitions, not draft identity: the draft id and
    // name are editing-session facts the portable document does not carry.
    expect(imported.definition).toEqual(exported.document.definition);
    const reExported = exportWorkflowDocument({ draft: imported.draft });
    expect(reExported.ok).toBe(true);
    if (!reExported.ok) return;
    expect(reExported.json).toBe(exported.json);
  });

  it('opens an unsaved, unnamed review draft rather than adopting the current one', () => {
    const currentDraft = openDraft();
    const exported = exportWorkflowDocument({ draft: draftWith([step('analyze')]) });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const imported = importWorkflowDocument({
      source: exported.json,
      currentDraft,
      draftId: 'draft-imported',
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.draft).not.toBe(currentDraft);
    expect(imported.draft.draftId).toBe('draft-imported');
    // The document carries no title, so the review draft stays unnamed and the
    // author must name it before the existing Save owner will accept it.
    expect(imported.draft.name).toBe('');
  });

  it('distinguishes malformed JSON, an unsupported version and a foreign document', () => {
    const currentDraft = openDraft();
    const definition = {
      version: 1,
      inputs: [],
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [step('analyze')],
    };

    const malformed = importWorkflowDocument({
      source: '{ "kind": "happier.workflow", ',
      currentDraft,
      draftId: 'draft-imported',
    });
    const unsupportedVersion = importWorkflowDocument({
      source: documentJson(definition, { version: 2 }),
      currentDraft,
      draftId: 'draft-imported',
    });
    const foreign = importWorkflowDocument({
      source: JSON.stringify({ kind: 'other.tool.pipeline', version: 1, definition }),
      currentDraft,
      draftId: 'draft-imported',
    });

    expect(malformed.ok).toBe(false);
    expect(unsupportedVersion.ok).toBe(false);
    expect(foreign.ok).toBe(false);
    if (malformed.ok || unsupportedVersion.ok || foreign.ok) return;

    expect(malformed.code).toBe('invalid_json');
    expect(unsupportedVersion.code).toBe('unsupported_version');
    expect(foreign.code).toBe('invalid_document');
    expect(new Set([malformed.code, unsupportedVersion.code, foreign.code]).size).toBe(3);

    expect(malformed.messageKey).toBe('workflows.interchange.importFailedInvalidJson');
    expect(unsupportedVersion.messageKey).toBe('workflows.interchange.importFailedUnsupportedVersion');
    expect(foreign.messageKey).toBe('workflows.interchange.importFailedInvalidDocument');
    expect(new Set([
      malformed.messageKey,
      unsupportedVersion.messageKey,
      foreign.messageKey,
    ]).size).toBe(3);
  });

  it('carries the canonical repairable issues for a valid envelope with an invalid definition', () => {
    const currentDraft = openDraft();
    const result = importWorkflowDocument({
      source: documentJson(definitionWithDanglingReference()),
      currentDraft,
      draftId: 'draft-imported',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_definition');
    // No invented copy: the editor points at the canonical issue location.
    expect(result.messageKey).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain('missing_reference');
    const missing = result.issues.find((issue) => issue.code === 'missing_reference');
    expect(missing?.path).toBe('/blocks/1/input/0/producer/blockId');
    expect(missing?.blockId).toBe('implement');
    expect(result.draft).toBe(currentDraft);
    expect(result.repairDraft).toBeDefined();
    expect(result.repairDraft).not.toBe(currentDraft);
    expect(result.repairDraft?.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
  });

  it('offers repair material only when the canonical validator produced a normalized definition', () => {
    const currentDraft = openDraft();
    const structurallyInvalid = importWorkflowDocument({
      source: documentJson({
        version: 1,
        inputs: [],
        defaults: { agentTarget: CLAUDE_AGENT_TARGET },
        blocks: [{ ...step('analyze'), unsupported: true }],
      }),
      currentDraft,
      draftId: 'draft-imported',
    });

    expect(structurallyInvalid.ok).toBe(false);
    if (structurallyInvalid.ok) return;
    expect(structurallyInvalid.issues.map((issue) => issue.code)).toContain('unknown_field');
    expect(structurallyInvalid.repairDraft).toBeUndefined();
    expect(structurallyInvalid.draft).toBe(currentDraft);
  });

  it('leaves the current draft untouched by identity on every failure', () => {
    const currentDraft = openDraft();
    const sources = [
      'not json at all',
      documentJson({ version: 1, blocks: [step('analyze')] }, { version: 7 }),
      JSON.stringify({ hello: 'world' }),
      documentJson(definitionWithDanglingReference()),
    ];

    for (const source of sources) {
      const result = importWorkflowDocument({ source, currentDraft, draftId: 'draft-imported' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.draft).toBe(currentDraft);
    }
  });

  it('resolves a document without a workflow Agent through the trusted host context', () => {
    const agentless = documentJson({
      version: 1,
      inputs: [],
      defaults: {},
      blocks: [step('analyze')],
    });

    const withoutContext = importWorkflowDocument({
      source: agentless,
      currentDraft: openDraft(),
      draftId: 'draft-imported',
    });
    expect(withoutContext.ok).toBe(false);
    if (withoutContext.ok) return;
    expect(withoutContext.code).toBe('invalid_definition');
    expect(withoutContext.issues.map((issue) => issue.code)).toContain('target_unavailable');

    const withContext = importWorkflowDocument({
      source: agentless,
      currentDraft: openDraft(),
      draftId: 'draft-imported',
      context: { agentTarget: CLAUDE_AGENT_TARGET },
    });
    expect(withContext.ok).toBe(true);
    if (!withContext.ok) return;
    expect(withContext.draft.defaults.agentTarget).toEqual(CLAUDE_AGENT_TARGET);
  });
});

describe('exportWorkflowDocument', () => {
  it('exports the mounted unsaved draft through the agent Action with exactly the UI JSON', async () => {
    const unexpected = (): never => { throw new Error('draft export must not access persistence'); };
    const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected, assertDefinitionWriteAllowed: unexpected,
      artifactStore: { read: unexpected, list: unexpected, create: unexpected, update: unexpected, delete: unexpected } });
    const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions,
      runs: { execute: unexpected } });
    const executor = createActionExecutor({ workflowAction });
    const draft = draftWith([step('unsaved-analysis'), step('unsaved-review')]);
    const expected = exportWorkflowDocument({ draft });
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error('invalid UI draft fixture');
    await expect(executor.execute('workflow.definition.export', { draft: buildWorkflowDefinitionCandidate(draft) }, { surface: 'agent' }))
      .resolves.toMatchObject({ ok: true, result: { json: expected.json, document: expected.document } });
  });
  it('refuses an invalid draft and names the first blocking issue', () => {
    const result = exportWorkflowDocument({
      draft: draftWith([
        step('analyze'),
        step('implement', {
          input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } }, path: [] }],
        }),
      ]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockingIssue?.code).toBe('missing_reference');
    expect(result.blockingIssue?.path).toBe('/blocks/1/input/0/producer/blockId');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('exports only the canonical definition, with no credentials or run content', () => {
    const result = exportWorkflowDocument({ draft: draftWith([step('analyze'), step('implement')]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['definition', 'kind', 'version']);
    expect(Object.keys(parsed['definition'] as Record<string, unknown>).sort())
      .toEqual(['blocks', 'defaults', 'inputs', 'version']);
    for (const forbidden of ['environmentVariables', 'runId', 'startedAt', 'progress', 'outcome', 'invocation']) {
      expect(result.json).not.toContain(forbidden);
    }
  });

  it('lets the canonical schema, not a hand-written filter, reject secret-bearing fields', () => {
    // `environmentVariables` is not a member of the canonical step selection.
    // The cast is the only way to present the shape a hand-rolled exporter
    // would have had to strip; the schema must reject it instead.
    const leaking = {
      ...step('leak'),
      execution: { environmentVariables: { TOKEN: 'secret' } },
    } as unknown as WorkflowStep;

    const result = exportWorkflowDocument({ draft: draftWith([leaking]) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('unknown_field');
  });

  it('previews the authored private-content consequence before sharing', () => {
    expect(WORKFLOW_EXPORT_PRIVACY_NOTE_KEY).toBe('workflows.interchange.exportPrivacyNote');
  });
});
