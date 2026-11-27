import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import {
  walkWorkflowBlocks,
  type WorkflowBlock,
} from '@happier-dev/protocol/workflows/workflowV1';

import { t } from '@/text';

import { buildWorkflowDefinitionCandidate } from './workflowAuthoring';
import { workflowBlockReferenceLabel } from './workflowBlockLabel';
import type { WorkflowEditorDraft } from './workflowEditorDraft';

export type WorkflowDraftBlockDifference = Readonly<{
  blockId: string;
  /** The block's name as the editor shows it. */
  label: string;
  /** `changed`: in both, differently; `onlyLocal`: only in the person's edits; `onlyCurrent`: only in the other version. */
  kind: 'changed' | 'onlyLocal' | 'onlyCurrent';
  /** A `changed` block whose only difference is one name the editor shows: that name as the editor shows it, in each version. */
  field?: WorkflowDraftNameDifference;
}>;

export type WorkflowDraftNameDifference = Readonly<{
  /** `name`: the block's own name; `laneName`: a Side by side lane's name, by its 1-based position. */
  target: Readonly<{ kind: 'name' }> | Readonly<{ kind: 'laneName'; position: number }>;
  local: string;
  current: string;
}>;

export type WorkflowDraftDifferences = Readonly<{
  name: boolean;
  /** Anything outside the blocks: inputs, defaults, roles, the final output. */
  settings: boolean;
  /** In the person's edits' order, then what only the other version has, in its order. */
  blocks: readonly WorkflowDraftBlockDifference[];
}>;

function isBlockRecord(
  value: unknown,
): value is Readonly<{ id: string; kind: string }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}

/** A block's own authored fields: each child block in its lists stands as its id, so a child's edit is the child's. */
function ownFields(block: WorkflowBlock): unknown {
  return JSON.parse(
    JSON.stringify(block, function (this: unknown, _key, value: unknown) {
      return Array.isArray(this) && isBlockRecord(value) ? value.id : value;
    }),
  );
}

/** A block's fields without the names the editor shows, so a rename alone compares equal. */
function unnamedFields(block: WorkflowBlock): unknown {
  const { name: _name, ...rest } = block;
  return ownFields((rest.kind === 'parallel'
    ? { ...rest, branches: rest.branches.map(({ name: _lane, ...branch }) => branch) } : rest) as WorkflowBlock);
}

/** The one name that differs between two versions of a block, when a rename is its only change. */
function nameDifference(local: WorkflowBlock, current: WorkflowBlock): WorkflowDraftNameDifference | undefined {
  if (!pluginJsonValuesEqual(unnamedFields(local), unnamedFields(current))) return undefined;
  const differences: WorkflowDraftNameDifference[] = [];
  if (local.name !== current.name) {
    differences.push({ target: { kind: 'name' }, local: workflowBlockReferenceLabel(local), current: workflowBlockReferenceLabel(current) });
  }
  if (local.kind === 'parallel' && current.kind === 'parallel') {
    local.branches.forEach((branch, index) => {
      const other = current.branches[index]?.name;
      if (branch.name === other) return;
      // An unnamed lane reads as the editor captions it.
      const caption = (name: string | undefined) => name?.trim() || t('workflows.page.inspector.lane', { position: index + 1 });
      differences.push({ target: { kind: 'laneName', position: index + 1 }, local: caption(branch.name), current: caption(other) });
    });
  }
  return differences.length === 1 ? differences[0] : undefined;
}

/** Everything the definition holds outside its blocks, as JSON. */
function settingsOf(draft: WorkflowEditorDraft): unknown {
  return JSON.parse(JSON.stringify(buildWorkflowDefinitionCandidate({ ...draft, blocks: [] })));
}

/** Where two drafts of one Workflow differ, in the editor's own terms (its names, steps and settings). */
export function listWorkflowDraftDifferences(
  local: WorkflowEditorDraft,
  current: WorkflowEditorDraft,
): WorkflowDraftDifferences {
  const localBlocks = walkWorkflowBlocks(local.blocks);
  const currentBlocks = new Map(
    walkWorkflowBlocks(current.blocks).map((block) => [
      block.id,
      block,
    ]),
  );
  const localIds = new Set(localBlocks.map((block) => block.id));
  const blocks: WorkflowDraftBlockDifference[] = [];
  for (const block of localBlocks) {
    const other = currentBlocks.get(block.id);
    if (other === undefined)
      blocks.push({
        blockId: block.id,
        label: workflowBlockReferenceLabel(block),
        kind: 'onlyLocal',
      });
    else if (!pluginJsonValuesEqual(ownFields(block), ownFields(other))) {
      const field = nameDifference(block, other);
      blocks.push({
        blockId: block.id,
        label: workflowBlockReferenceLabel(block),
        kind: 'changed',
        ...(field ? { field } : {}),
      });
    }
  }
  for (const block of currentBlocks.values()) {
    if (!localIds.has(block.id))
      blocks.push({
        blockId: block.id,
        label: workflowBlockReferenceLabel(block),
        kind: 'onlyCurrent',
      });
  }
  return {
    name: local.name !== current.name,
    settings: !pluginJsonValuesEqual(settingsOf(local), settingsOf(current)),
    blocks,
  };
}
