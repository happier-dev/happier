import { describe, expect, it } from 'vitest';
import type { PluginJsonSchemaV2 } from '@happier-dev/plugin-sdk/actions';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';

describe('Codex native structured output', () => {
  it('constrains only the requested turn through the app-server protocol', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const runtime = await fixture.openConfiguredRun();
      const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false } satisfies PluginJsonSchemaV2;
      try {
        await expect(runtime.send({ inputIds: ['schema-input'], input: { text: 'inspect', outputSchema },
          delivery: { kind: 'newTurn', turnId: 'schema-turn' } })).resolves.toMatchObject({ status: 'admitted' });
        expect(fixture.requests.findLast(request => request.method === 'turn/start')?.params.outputSchema).toEqual(outputSchema);
        await runtime.cancel({ turnId: 'schema-turn' });
        await runtime.send({ inputIds: ['plain-input'], input: { text: 'explain' }, delivery: { kind: 'newTurn', turnId: 'plain-turn' } });
        expect(fixture.requests.findLast(request => request.method === 'turn/start')?.params).not.toHaveProperty('outputSchema');
      } finally { await runtime.dispose(); }
    });
  });
});
