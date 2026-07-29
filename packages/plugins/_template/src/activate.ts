import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  ActionHandler,
  HookHandler,
} from '@happier-dev/plugin-sdk/runtime';

export const saveNote: ActionHandler = async (input, context) => {
  const note = typeof input === 'object'
    && input !== null
    && 'note' in input
    && typeof input.note === 'string'
    ? input.note
    : '';
  await context.services.storage.local.set('latestNote', note);
  return { note: await context.services.storage.local.get('latestNote') };
};

export const handleSessionSpawned: HookHandler = (_payload, context) => {
  context.services.logger.debug('template plugin observed session spawn');
};

export function activate(api: PluginApi): void {
  api.actions.register('save-note', saveNote);
  api.hooks.register('session-spawned', handleSessionSpawned);
}
