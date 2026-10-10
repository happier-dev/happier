import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';

import type { IconName } from '@/components/ui/icons/Icon';

/**
 * The one glyph for each kind of authored block (lab `uw-editor.js`: `wf`, `zap`, `fork`, `repeat`,
 * `ifd`). The document's block headings, the Flow map and the Add menu name a kind with the same mark,
 * so a block never changes its glyph between the place it is added, written and drawn. An Agent step
 * prefers its Agent's own mark; this glyph stands in when none is known.
 */
export const WORKFLOW_BLOCK_KIND_GLYPH = {
    step: 'chat-circle',
    workflow: 'tree-structure',
    action: 'lightning',
    wait: 'hand',
    parallel: 'git-branch',
    loop: 'repeat',
    if: 'diamond',
} as const satisfies Readonly<Record<WorkflowBlock['kind'], IconName>>;
