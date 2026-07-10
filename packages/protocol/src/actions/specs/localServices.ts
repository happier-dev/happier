import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import { LocalServiceActionRequestV1Schema, LocalServiceActionResultV1Schema } from '../../local/services/actions/v1.js';
import { LocalServiceInventorySnapshotV1Schema } from '../../local/services/inventory/v1.js';
import {
  DaemonLocalServiceLauncherStartRequestV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema,
  LocalServiceLauncherSnapshotV1Schema,
} from '../../local/services/launcher/v1.js';
import { LocalServicePreviewSnapshotV1Schema } from '../../local/services/preview/v1.js';
import { LocalServicePublicExposureV1Schema } from '../../local/services/public/v1.js';
import { refineKindSchema, type RuntimeActionSpecFamily } from './common.js';

const RuntimeLocalServiceMachineInputSchema = z
  .object({
    machineId: z.string().trim().min(1).max(256).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: z.string().trim().min(1).max(256).optional(),
  })
  .passthrough();

const RuntimeLocalServiceLauncherActionInputSchema = RuntimeLocalServiceMachineInputSchema.extend({
  targetId: z.string().trim().min(1).max(256).optional(),
}).passthrough();

const RuntimeLocalServicePreviewActionInputSchema = RuntimeLocalServiceMachineInputSchema.extend({
  previewId: z.string().trim().min(1).max(256).optional(),
  targetId: z.string().trim().min(1).max(256).optional(),
}).passthrough();

const RuntimeLocalServicePublicPreviewActionInputSchema = RuntimeLocalServicePreviewActionInputSchema.extend({
  exposureId: z.string().trim().min(1).max(256).optional(),
  mode: z.enum(['authenticated', 'secret_link', 'public']).optional(),
  ttlMs: z.number().int().positive().optional(),
}).passthrough();

export const LOCAL_SERVICES_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'localServices.inventory.list': 'List local services',
  'localServices.inventory.refresh': 'Refresh local services',
  'localServices.launcher.snapshot': 'Get local service launcher snapshot',
  'localServices.launcher.start': 'Start local service launcher target',
  'localServices.launcher.openPreview': 'Open local service launcher preview',
  'localServices.launcher.registerPreview': 'Register local service launcher preview',
  'localServices.launcher.history.clear': 'Clear local service launcher history',
  'localServices.preview.openOrCreate': 'Open or create local service preview',
  'localServices.preview.status': 'Get local service preview status',
  'localServices.preview.revoke': 'Revoke local service preview',
  'localServices.publicPreview.create': 'Create public local service preview',
  'localServices.publicPreview.status': 'Get public local service preview status',
  'localServices.publicPreview.revoke': 'Revoke public local service preview',
  'localServices.publicPreview.copyUrl': 'Copy public local service preview URL',
  'localServices.actions.copyUrl': 'Copy local service URL',
  'localServices.actions.openPreview': 'Open local service preview',
  'localServices.actions.forget': 'Forget local service',
  'localServices.actions.stopManaged': 'Stop managed local service',
  'localServices.actions.restartManaged': 'Restart managed local service',
  'localServices.actions.terminateDetected': 'Terminate detected local service',
});

export const LOCAL_SERVICES_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'localServices.inventory.list': 'List the local services detected on a machine.',
  'localServices.inventory.refresh': 'Refresh the detected local services inventory.',
  'localServices.launcher.snapshot': 'Read the current local service launcher state.',
  'localServices.launcher.start': 'Start a managed local service from a launch target.',
  'localServices.launcher.openPreview': 'Open a browser preview for a local service launch target.',
  'localServices.launcher.registerPreview': 'Register a browser preview for a local service launch target.',
  'localServices.launcher.history.clear': 'Clear the local service launcher history.',
  'localServices.preview.openOrCreate': 'Open an existing or create a new private local service preview.',
  'localServices.preview.status': 'Read the status of a local service preview.',
  'localServices.preview.revoke': 'Revoke a local service preview.',
  'localServices.publicPreview.create': 'Create a public exposure for a local service preview (requires confirmation).',
  'localServices.publicPreview.status': 'Read the status of a local service public exposure.',
  'localServices.publicPreview.revoke': 'Revoke a local service public exposure.',
  'localServices.publicPreview.copyUrl': 'Copy the public URL of a local service exposure.',
  'localServices.actions.copyUrl': 'Copy the URL of a local service.',
  'localServices.actions.openPreview': 'Open a browser preview for a local service.',
  'localServices.actions.forget': 'Forget a detected local service.',
  'localServices.actions.stopManaged': 'Stop a Happier-managed local service.',
  'localServices.actions.restartManaged': 'Restart a Happier-managed local service.',
  'localServices.actions.terminateDetected': 'Terminate a detected (non-managed) local service.',
});

const LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'localServices.actions.copyUrl': 'copy_url',
  'localServices.actions.openPreview': 'open_preview',
  'localServices.actions.forget': 'forget',
  'localServices.actions.stopManaged': 'stop_managed',
  'localServices.actions.restartManaged': 'restart_managed',
  'localServices.actions.terminateDetected': 'terminate_detected',
});

function refineLocalServiceActionSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny {
  const expected = LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION[actionId];
  if (!expected) return RuntimeLocalServiceMachineInputSchema;
  return refineKindSchema(LocalServiceActionRequestV1Schema, 'action', expected, 'Local service action');
}

function localServicesRuntimeActionInputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (actionId.startsWith('localServices.inventory.')) return RuntimeLocalServiceMachineInputSchema;
  if (actionId === 'localServices.launcher.snapshot') return RuntimeLocalServiceMachineInputSchema;
  if (actionId === 'localServices.launcher.start') return DaemonLocalServiceLauncherStartRequestV1Schema;
  if (actionId.startsWith('localServices.launcher.')) return RuntimeLocalServiceLauncherActionInputSchema;
  if (actionId.startsWith('localServices.preview.')) return RuntimeLocalServicePreviewActionInputSchema;
  if (actionId.startsWith('localServices.publicPreview.')) return RuntimeLocalServicePublicPreviewActionInputSchema;
  if (actionId.startsWith('localServices.actions.')) return refineLocalServiceActionSchema(actionId);
  return null;
}

function localServicesRuntimeActionOutputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (actionId.startsWith('localServices.inventory.')) return LocalServiceInventorySnapshotV1Schema;
  if (actionId === 'localServices.launcher.start') return DaemonLocalServiceLauncherStartResponseV1Schema;
  if (actionId.startsWith('localServices.launcher.')) return LocalServiceLauncherSnapshotV1Schema.or(z.unknown());
  if (actionId.startsWith('localServices.preview.')) return LocalServicePreviewSnapshotV1Schema.or(z.unknown());
  if (actionId.startsWith('localServices.publicPreview.')) return LocalServicePublicExposureV1Schema.or(z.array(LocalServicePublicExposureV1Schema)).or(z.unknown());
  if (actionId.startsWith('localServices.actions.')) return LocalServiceActionResultV1Schema;
  return null;
}

export const LOCAL_SERVICES_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: LOCAL_SERVICES_RUNTIME_ACTION_TITLES,
  descriptions: LOCAL_SERVICES_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemaForAction: localServicesRuntimeActionInputSchema,
  outputSchemaForAction: localServicesRuntimeActionOutputSchema,
} satisfies RuntimeActionSpecFamily);
