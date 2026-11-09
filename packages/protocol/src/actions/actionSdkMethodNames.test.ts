import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Match catalog.initialization.test.ts: cold source loading is fixture setup,
// outside the behavior assertion deadline, with no new import timeout.
const sourceImport = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { VOICE_CONVERSATION_ACTION_SPECS } from './packages/protocol/src/actions/voiceConversationActionFamily.ts';

      // Model an author introducing an SDK-only namespace collision before the
      // shared catalog is evaluated; keep the real Action schemas and ids.
      const start = VOICE_CONVERSATION_ACTION_SPECS.find(row => row.id === 'ui.voice_global.say.start');
      assert.ok(start);
      start.bindings = { ...start.bindings, sdkMethod: 'ui.voiceGlobal.say' };
      const catalog = await import('./packages/protocol/src/actions/actionSpecs.ts');
      assert.equal(catalog.getActionSpec(start.id).id, start.id);
      const { renderGeneratedActions } = await import('./packages/sdk/scripts/generateActions.ts');
      const rows = catalog.PUBLIC_ACTION_IDS.map(actionId => ({
        actionId, methodPath: catalog.resolveActionSdkMethodName(catalog.getActionSpec(actionId)),
      }));
      assert.throws(() => renderGeneratedActions(rows), /conflict at SDK namespace/);
      const corrected = rows.map(row => row.actionId === start.id
        ? { ...row, methodPath: 'ui.voiceGlobal.say.start' } : row);
      assert.match(renderGeneratedActions(corrected), /ui.voice_global.say.start/);
`], {
  cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
  encoding: 'utf8',
});

describe('Action SDK method-name validation', () => {
  it('loads the runtime catalog with colliding SDK metadata while generation refuses it', () => {
    expect(sourceImport.error).toBeUndefined();
    expect(sourceImport.status, sourceImport.stdout + sourceImport.stderr).toBe(0);
  });
});
