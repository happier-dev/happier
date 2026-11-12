import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { openTriageActionEditorV1 } from './openActionEditor.js';

it('lets the existing mounted action presenter receive the original editor navigation refusal', async () => {
    const error = new PluginError({ code: 'editor_unavailable', details: { requestId: 'editor-17' } });
    await expect(openTriageActionEditorV1({ openSurface: async () => { throw error; } }, {})).rejects.toBe(error);
});


it('settles a dismissed editor navigation without presenting a failure', async () => {
    await expect(openTriageActionEditorV1({ openSurface: async () => { throw new PluginError({ code: 'cancelled' }); } }, {})).resolves.toBeUndefined();
});
