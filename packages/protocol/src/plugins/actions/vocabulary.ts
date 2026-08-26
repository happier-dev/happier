import { z } from 'zod';

/**
 * The bounded vocabulary shared by Action declarations and target-owned
 * contribution operations. Keep these values in the Action domain without
 * requiring consumers to load the full Action declaration grammar.
 */
export const PluginActionSurfaceV2Schema = z.enum([
  'cli',
  'mcp',
  'agent',
  'ui',
  'plugin',
  'voice',
]);
export type PluginActionSurfaceV2 = z.infer<typeof PluginActionSurfaceV2Schema>;

export const PluginActionDangerLevelV2Schema = z.enum([
  'safe',
  'writesLocal',
  'writesRemote',
  'externalSideEffect',
  'destructive',
]);
export type PluginActionDangerLevelV2 = z.infer<typeof PluginActionDangerLevelV2Schema>;
