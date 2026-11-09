import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionSpawnNewInputV2Schema } from '../../../packages/protocol/src/sessions/creation/sessionSpawnNewInputV2.ts';
import { AutomationScheduleTriggerInputSchema } from '../../../packages/protocol/src/automations/automationTriggerDefinition.ts';
import { getActionSpec } from '../../../packages/protocol/src/actions/actionSpecs.ts';
import { ExternalActionRequestEnvelopeV1Schema } from '../../../packages/protocol/src/actions/externalActionApi.ts';
import { ApiTokenGrantV1Schema } from '../../../packages/protocol/src/auth/apiTokenGrant.ts';
import { McpServerCatalogEntryV1Schema } from '../../../packages/protocol/src/mcp/servers/settingsV1.ts';
import { WorkflowDefinitionSchema } from '../../../packages/protocol/src/workflows/workflowV1.ts';
import { validateWorkflowDefinition } from '../../../packages/protocol/src/workflows/workflowValidationV1.ts';
import { ConversationStartInputV1Schema, ConversationOutboundTextLimitV1Schema } from '@happier-dev/channels-protocol/v1';
import { SessionDirectoryIntentV1Schema } from '../../../packages/protocol/src/sessions/creation/sessionDirectoryIntentV1.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
function examples(source) {
  return [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
}
function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object example');
  return value;
}

describe('Email integration documentation examples through canonical schemas', () => {
  it('admits the channel assistant recipe and existing-conversation schedule through their owners', () => {
    const [recipe, schedule] = examples(read('apps/docs/content/docs/extending/channels.mdx'));
    SessionSpawnNewInputV2Schema.parse(recipe);
    AutomationScheduleTriggerInputSchema.parse(schedule);
  });

  it('admits the published HTTP spawn, send, history and run-now envelopes and restricted grant', () => {
    const source = read('apps/docs/content/docs/extending/sdk.mdx');
    const section = source.slice(source.indexOf('### Backend HTTP quickstart'), source.indexOf('The v1 protocol has one relative path'));
    const values = examples(section);
    expect(values).toHaveLength(5);
    const actions = ['session.spawn_new', 'session.message.send', 'session.transcript.get', 'workflow.trigger.run_now'];
    for (const [index, value] of [values[0], values[1], values[2], values[4]].entries()) {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
      const spec = getActionSpec(actions[index]);
      const schema = spec.surfaceBindings?.api?.inputSchema ?? spec.inputSchema;
      expect(schema.safeParse(envelope.input).success, `${actions[index]}: ${JSON.stringify(schema.safeParse(envelope.input))}`).toBe(true);
    }
    ApiTokenGrantV1Schema.parse(values[3]);
  });

  it('admits route recipe, MCP headers, workflow, schedule and both resolved start inputs', async () => {
    const [recipe, remote, workflow, schedule] = examples(read('apps/docs/content/docs/extending/email-agent-recipes.mdx'));
    const checked = await Promise.allSettled([
      (async () => {
        SessionSpawnNewInputV2Schema.parse({ ...object(recipe), executionTarget: { serverId: 'example-home', machineId: 'example-machine' } });
        return 'recipe';
      })(),
      (async () => {
        McpServerCatalogEntryV1Schema.parse({ id: 'wilson-intake-entry-id', name: 'wilson-intake', transport: 'http',
          remote, env: {}, createdAt: 0, updatedAt: 0 });
        return 'MCP';
      })(),
      (async () => {
        AutomationScheduleTriggerInputSchema.parse(schedule);
        return 'schedule';
      })(),
      (async () => {
        const definition = WorkflowDefinitionSchema.parse(workflow);
        expect(validateWorkflowDefinition(definition)).toMatchObject({ valid: true });
        return 'workflow';
      })(),
      (async () => {
        const content = { text: 'Brief', html: `<html>${'x'.repeat(120 * 1024)}</html>` };
        for (const block of object(workflow).blocks) {
          if (block.kind !== 'action') continue;
          const input = Object.fromEntries(Object.entries(block.input).map(([field, binding]) => [field,
            binding.kind === 'literal' ? binding.value : binding.kind === 'origin_session_id' ? 'brief-session-id' : content]));
          ConversationStartInputV1Schema.parse(input);
        }
        ConversationOutboundTextLimitV1Schema.parse({ maximum: 65536, unit: 'unicodeCodePoints' });
        return 'conversation start and native limit';
      })(),
    ]);
    const failures = checked.filter(result => result.status === 'rejected');
    console.info('Validated example contracts:', checked.filter(result => result.status === 'fulfilled').map(result => result.value));
    if (failures.length) throw new AggregateError(failures.map(result => result.reason),
      `Canonical example validation failed: ${failures.map(result => String(result.reason)).join('; ')}`);
  });

  it('parses every directory object in the corrected SDK examples through the directory owner', () => {
    for (const path of ['packages/sdk/README.md', 'apps/docs/content/docs/extending/sdk.mdx']) {
      const declarations = [...read(path).matchAll(/directory:\s*(\{[^\n}]+\})/g)];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        const literal = declaration[1].replace('process.cwd()', "'/example/workspace'");
        // A bounded object literal from authored docs, never evaluated as executable code.
        const json = literal.replace(/\b(kind|path):/g, '"$1":').replace(/'([^']*)'/g, '"$1"');
        SessionDirectoryIntentV1Schema.parse(JSON.parse(json));
      }
    }
  });
});
