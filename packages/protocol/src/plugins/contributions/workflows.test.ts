import { describe, expect, it } from 'vitest';
import { PluginContributesV2Schema } from './v2.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2, derivePluginDaemonContributionRegistrationRights } from './catalog.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { walkWorkflowBlocks } from '../../workflows/workflowDefinitionEditV1.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';

const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{
  kind: 'wait', id: 'review', document: { text: 'Review the result.', references: [], attachments: [] },
  result: { kind: 'text' },
}] });

describe('declarative plugin workflows', () => {
  it('qualifies local Actions in every block position while preserving host and qualified references', () => {
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'workflows')!;
    const authored = { id: 'post', title: 'Post', definition: { version: 1, blocks: [{
      kind: 'loop', id: 'rounds', repetition: { kind: 'evaluate', maxIterations: 2, history: 'latest',
        evaluator: { kind: 'action', id: 'judge', actionId: 'judge', input: {} } },
      body: [{ kind: 'parallel', id: 'fanout', failurePolicy: 'fail_stop', branches: [{ id: 'lane', blocks: [{
        kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [{ kind: 'action', id: 'local', actionId: 'post', input: {} },
          { kind: 'action', id: 'host', actionId: 'notifications.notify_me', input: {} },
          { kind: 'action', id: 'plain-host', actionId: 'wait', input: {} },
          { kind: 'action', id: 'nested-local', actionId: 'wait/check', input: {} }],
        otherwise: [{ kind: 'action', id: 'foreign', actionId: 'com.other.plugin/post', input: {} },
          { kind: 'action', id: 'unavailable', actionId: 'com.missing.plugin/post', input: {} }],
      }] }] }],
    }] } };
    const normalized = family.canonicalize(authored, { pluginId: 'com.acme.post' });
    const parsed = PluginContributesV2Schema.parse({ workflows: [normalized] }).workflows[0]!;
    expect(walkWorkflowBlocks(parsed.definition.blocks).flatMap((block) => block.kind === 'action' ? [block.actionId] : [])).toEqual([
      'com.acme.post/judge', 'com.acme.post/post', 'notifications.notify_me', 'wait', 'com.acme.post/wait/check',
      'com.other.plugin/post', 'com.missing.plugin/post',
    ]);
    expect(family.canonicalize(normalized, { pluginId: 'com.acme.post' })).toEqual(normalized);
    expect(authored.definition.blocks[0]?.repetition.evaluator.actionId).toBe('judge');
  });

  it('admits canonical workflow definitions and rejects malformed nested definitions', () => {
    const workflow = { id: 'review', title: 'Review the result', definition };
    const parsed = PluginContributesV2Schema.safeParse({ workflows: [workflow] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).toMatchObject({ workflows: [workflow] });
    expect(PluginContributesV2Schema.safeParse({ workflows: [{ ...workflow,
      definition: { ...definition, blocks: [{ ...definition.blocks[0], kind: 'unknown' }] },
    }] }).success).toBe(false);
  });

  it('uses the manifest catalog for read-only workflow declarations without executable registration rights', () => {
    const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'com.acme.workflows',
      version: '1.0.0', displayName: 'Workflows', runtime: { apiVersion: 1 },
      contributes: { workflows: [{ id: 'review', title: 'Review the result', definition }] },
    });
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'workflows');
    expect(family).toMatchObject({ activationDemand: 'none', allowedRuntimeRegistration: null,
      projectionFamily: 'workflows' });
    expect(derivePluginDaemonContributionRegistrationRights(manifest)).toEqual([]);
  });
});
