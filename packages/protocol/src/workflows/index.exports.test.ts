import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PortableComposerAttachmentV1Schema,
  type PortableComposerAttachmentV1,
  WorkflowStepComposerDocumentSchema,
} from './index.js';
import {
  PortableComposerAttachmentV1Schema as canonicalPortableComposerAttachmentV1Schema,
  type PortableComposerAttachmentV1 as CanonicalPortableComposerAttachmentV1,
} from '../runtime/input/composerAttachmentV1.js';
import {
  PortableComposerAttachmentV1Schema as rootPortableComposerAttachmentV1Schema,
  type PortableComposerAttachmentV1 as RootPortableComposerAttachmentV1,
} from '../index.js';
import {
  WorkflowStepComposerDocumentSchema as canonicalWorkflowStepComposerDocumentSchema,
} from './workflowComposerDocumentV1.js';
import {
  WorkflowStepComposerDocumentSchema as workflowDefinitionComposerDocumentSchema,
  WorkflowLeafExecutionTargetV1Schema,
} from './workflowV1.js';
import { WorkflowRunExecutionTargetV1Schema } from './workflowDefinitionV1.js';

describe('Workflow public exports', () => {
  it('re-exports the canonical portable composer attachment contract', () => {
    expect(PortableComposerAttachmentV1Schema)
      .toBe(canonicalPortableComposerAttachmentV1Schema);
    expect(rootPortableComposerAttachmentV1Schema)
      .toBe(canonicalPortableComposerAttachmentV1Schema);
    expectTypeOf<PortableComposerAttachmentV1>()
      .toEqualTypeOf<CanonicalPortableComposerAttachmentV1>();
    expectTypeOf<RootPortableComposerAttachmentV1>()
      .toEqualTypeOf<CanonicalPortableComposerAttachmentV1>();
  });

  it('re-exports one canonical workflow Composer document schema', () => {
    expect(WorkflowStepComposerDocumentSchema)
      .toBe(canonicalWorkflowStepComposerDocumentSchema);
    expect(workflowDefinitionComposerDocumentSchema)
      .toBe(canonicalWorkflowStepComposerDocumentSchema);
  });

  it('retains one execution-target parser for Workflow leaves and admitted Runs', () => {
    expect(WorkflowRunExecutionTargetV1Schema).toBe(WorkflowLeafExecutionTargetV1Schema);
    expect(WorkflowRunExecutionTargetV1Schema.parse({ kind: 'detached_run' })).toEqual({ kind: 'detached_run' });
    expect(WorkflowRunExecutionTargetV1Schema.safeParse({ kind: 'detached_run', extra: true }).success).toBe(false);
  });
});
