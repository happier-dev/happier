import { LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/localServices';
import { LocalServiceInventorySnapshotV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { DaemonLocalServiceLauncherHistoryClearResponseV1Schema, DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema, LocalServiceLauncherSnapshotV1Schema,
  type LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePreviewOpenOrCreateResponseV1Schema, DaemonLocalServicePreviewRevokeResponseV1Schema,
  LocalServicePreviewSnapshotV1Schema, type LocalServicePreviewSnapshotRowV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { DaemonLocalServicePublicPreviewCreateResponseV1Schema, DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
  LocalServicePublicPreviewSnapshotV1Schema, type LocalServicePublicExposureV1 } from '@happier-dev/protocol/local/services/public/v1';
import { LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';

import type { ActionCliPresentation } from './commandPresentation';

function presentLauncher(snapshot: LocalServiceLauncherSnapshotV1): void {
  console.log(`Machine ${snapshot.machineId}${snapshot.sessionId ? ` · Session ${snapshot.sessionId}` : ''}`);
  for (const target of snapshot.targets) {
    console.log(`${target.title} · ${target.serviceState ?? target.state} · ${target.source} · ${target.id}`);
    if (target.cwd) console.log(`  ${target.cwd}`);
    if (target.endpointUrl) console.log(`  ${target.endpointUrl}`);
    else if (target.endpointKind === 'none') console.log('  No web endpoint');
    if (target.unavailableReason) console.log(`  ${target.unavailableReason}`);
  }
  if (snapshot.targets.length === 0) console.log('No launcher targets');
}

function presentPrivatePreview(row: LocalServicePreviewSnapshotRowV1): void {
  console.log(`${row.resource.display.title} · ${row.previewId} · Machine ${row.resource.machineId}`);
  console.log(`  ${row.accessUrl ?? row.accessUnavailableReasonCode ?? 'Private preview access unavailable'}`);
  if (row.expiresAt !== null) console.log(`  Expires ${new Date(row.expiresAt).toISOString()}`);
}

function presentPublicExposure(exposure: LocalServicePublicExposureV1): void {
  console.log(`${exposure.exposureId} · ${exposure.mode} · ${exposure.state} · Machine ${exposure.machineId}`);
  console.log(`  ${exposure.publicUrl}`);
  console.log(`  Expires ${new Date(exposure.expiresAt).toISOString()}`);
}

export const LOCAL_SERVICES_PRESENTATION: ActionCliPresentation = {
  classifyResult: (payload, context) => {
    const actionId = context.command.actionId;
    if (!Object.hasOwn(LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS, actionId)) return null;
    const schema = LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS[actionId as keyof typeof LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS];
    const result = schema.parse(payload);
    if ('status' in result && (result.status === 'denied' || result.status === 'failed' || result.status === 'unavailable')) {
      return { errorCode: 'reasonCode' in result && result.reasonCode ? result.reasonCode : 'local_service_unavailable', details: result };
    }
    return null;
  },
  presentSuccess: (payload, context) => {
    if (context.json) return false;
    switch (context.command.actionId) {
      case 'localServices.inventory.list':
      case 'localServices.inventory.refresh': {
        const snapshot = LocalServiceInventorySnapshotV1Schema.parse(payload);
        console.log(`Machine ${snapshot.machineId} · ${snapshot.refreshState}`);
        for (const entry of snapshot.entries) {
          console.log(`${entry.presentation?.displayName ?? entry.id} · ${entry.state} · ${entry.address.host}:${entry.port}`);
          if (entry.provenance?.process?.cwd) console.log(`  ${entry.provenance.process.cwd}`);
        }
        if (snapshot.entries.length === 0) console.log('No detected services');
        return true;
      }
      case 'localServices.launcher.snapshot': presentLauncher(LocalServiceLauncherSnapshotV1Schema.parse(payload)); return true;
      case 'localServices.launcher.start': {
        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(payload);
        console.log(`Start ${result.targetId}: ${result.status}`);
        presentLauncher(result.snapshot);
        return true;
      }
      case 'localServices.launcher.registerPreview': {
        const result = DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema.parse(payload);
        console.log(`Preview metadata ${result.status}: ${result.previewId ?? result.targetId}`);
        return true;
      }
      case 'localServices.launcher.history.clear': {
        const result = DaemonLocalServiceLauncherHistoryClearResponseV1Schema.parse(payload);
        console.log(`Cleared ${result.cleared} launcher history entries`);
        return true;
      }
      case 'localServices.preview.status': {
        const snapshot = LocalServicePreviewSnapshotV1Schema.parse(payload);
        console.log(`Machine ${snapshot.machineId} · ${snapshot.refreshState}`);
        for (const row of snapshot.previews ?? []) presentPrivatePreview(row);
        for (const resource of snapshot.resources) {
          if (!(snapshot.previews ?? []).some(row => row.previewId === resource.previewId)) {
            console.log(`${resource.display.title} · ${resource.previewId} · registered metadata; access unavailable`);
          }
        }
        if (snapshot.resources.length === 0 && !snapshot.previews?.length) console.log('No registered private previews');
        return true;
      }
      case 'localServices.preview.openOrCreate': {
        const result = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(payload);
        console.log(`Private preview ${result.status}`);
        presentPrivatePreview(result.preview);
        return true;
      }
      case 'localServices.preview.revoke': {
        const result = DaemonLocalServicePreviewRevokeResponseV1Schema.parse(payload);
        console.log(`${result.previewId}: ${result.revoked ? 'revoked' : 'not revoked'}`);
        return true;
      }
      case 'localServices.publicPreview.status': {
        const snapshot = LocalServicePublicPreviewSnapshotV1Schema.parse(payload);
        console.log(`Machine ${snapshot.machineId} · ${snapshot.refreshState} · public policy ${snapshot.policy.enabled ? 'enabled' : 'disabled'}`);
        for (const exposure of snapshot.exposures) presentPublicExposure(exposure);
        if (snapshot.exposures.length === 0) console.log('No public exposures');
        return true;
      }
      case 'localServices.publicPreview.create': presentPublicExposure(DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse(payload).exposure); return true;
      case 'localServices.publicPreview.revoke': {
        const result = DaemonLocalServicePublicPreviewRevokeResponseV1Schema.parse(payload);
        console.log(`${result.exposureId}: revoked ${new Date(result.revokedAt).toISOString()}`);
        for (const exposure of result.snapshot.exposures) presentPublicExposure(exposure);
        return true;
      }
      case 'localServices.actions.forget':
      case 'localServices.actions.stopManaged':
      case 'localServices.actions.restartManaged':
      case 'localServices.actions.terminateDetected': {
        const result = LocalServiceActionResultV1Schema.parse(payload);
        console.log(`${result.action}: ${result.status} · ${result.requestId}`);
        return true;
      }
      default: return false;
    }
  },
};
