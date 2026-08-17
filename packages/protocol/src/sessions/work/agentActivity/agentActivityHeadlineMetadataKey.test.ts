import { describe, expect, it } from 'vitest';

import {
  createSessionOwnerMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1,
} from '../../metadata/sessionMetadataEnvelopesV1.js';
import { buildSessionWorkflowActivityHeadline } from '../workflow/sessionWorkflowActivityHeadlineBuild.js';
import type { SessionWorkflowRunHeadlineV1 } from '../workflow/sessionWorkflowActivityHeadlineV1.js';
import { buildSessionAgentActivityHeadline } from './agentActivityHeadlineBuild.js';
import {
  SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
  readSessionAgentActivityHeadlineFromMetadata,
} from './agentActivityHeadlineV1.js';
import type { SessionAgentActivityEntryV1 } from './agentActivityEntryV1.js';

/**
 * The metadata key is a wire contract in three separate ways, and each half is pinned here:
 *
 * 1. Its LITERAL spelling. `../remote-dev` writes and reads the same string; renaming it silently
 *    empties every existing client's roster, exactly as renaming the sibling workflow key would.
 * 2. Its ACCEPTANCE by the owner-metadata projection. `createSessionOwnerMetadataV1` is on the live
 *    write path (`packages/cli-common/src/sessionMetadata/updateSessionMetadataTupleWithRetry.ts`
 *    throws `metadata_privacy_upgrade_required` on an unsupported field), so a producer publishing
 *    this key before the envelope knows it does not merely lose the roster — it kills the whole
 *    metadata write, including the workflow headline that used to work.
 * 3. Its SURVIVAL through the owner round-trip. An envelope that accepted the key but dropped its
 *    entries would leave a roster that is silently empty on every cold open.
 */

function agentEntry(overrides: Partial<SessionAgentActivityEntryV1> = {}): SessionAgentActivityEntryV1 {
  return {
    entryId: 'workflow_agent:wf_1:a1',
    kind: 'workflow_agent',
    title: 'Audit the corridor',
    status: 'running',
    updatedAt: 1_700_000_000_000,
    runId: 'wf_1',
    parentId: 'workflow_run:wf_1',
    ...overrides,
  };
}

function workflowRunHeadline(): SessionWorkflowRunHeadlineV1 {
  return {
    runId: 'wf_1',
    title: 'Port the wire wave',
    status: 'active',
    updatedAt: 1_700_000_000_000,
    recordRevision: '3',
    recordUpdatedAt: 1_700_000_000_000,
    totalAgents: 1,
    completedAgents: 0,
  };
}

describe('agent-activity headline metadata key', () => {
  it('is spelled exactly as every other build spells it', () => {
    // Hand-written literal on purpose: deriving it from the constant would assert nothing.
    expect(SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY).toBe('sessionAgentActivityHeadlineV1');
  });

  it('is accepted by the owner-metadata projection alongside the workflow key', () => {
    const metadata = {
      sessionWorkflowActivityHeadlineV1: buildSessionWorkflowActivityHeadline({
        backendId: 'claude',
        updatedAt: 1_700_000_000_000,
        runs: [workflowRunHeadline()],
      }),
      [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: buildSessionAgentActivityHeadline({
        backendId: 'claude',
        updatedAt: 1_700_000_000_000,
        entries: [agentEntry()],
      }),
    };

    const created = createSessionOwnerMetadataV1({ metadata });

    expect(created).toMatchObject({ ok: true });
  });

  it('round-trips the roster through the owner compatibility view without losing entries', () => {
    const headline = buildSessionAgentActivityHeadline({
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 1_700_000_000_000,
      entries: [
        agentEntry(),
        agentEntry({
          entryId: 'workflow_agent:wf_1:a2',
          title: 'Land the publisher',
          status: 'succeeded',
          updatedAt: 1_700_000_000_500,
        }),
      ],
    });

    const created = createSessionOwnerMetadataV1({
      metadata: { [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: headline },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const view = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: projectSessionSharedMetadataV1({ metadata: {} }),
      ownerMetadata: created.ownerMetadata,
    });
    const readBack = readSessionAgentActivityHeadlineFromMetadata(view);

    expect(readBack?.activeEntries.map((entry) => entry.entryId)).toEqual(['workflow_agent:wf_1:a1']);
    expect(readBack?.recentEntries?.map((entry) => entry.entryId)).toEqual(['workflow_agent:wf_1:a2']);
    expect(readBack?.primaryEntryId).toBe('workflow_agent:wf_1:a1');
  });
});
