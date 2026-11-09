import { describe, expect, it } from 'vitest';

import { getActionSpec } from '../actionSpecs.js';
import { getActionDefinitionForCatalogSurface } from '../actionCatalog.js';
import { compileActionInputJsonSchema } from '../actionInputJsonSchemaValidation.js';
import { zodSchemaToJsonSchemaObject } from '../actionInputJsonSchema.js';
import { parseLocalServiceDomainActionRpcRequest } from './localServices.js';
import { DaemonLocalServicePreviewOpenOrCreateRequestV1Schema } from '../../local/services/preview/v1.js';
import {
  DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
  DaemonLocalServicePublicPreviewCreateRequestV1Schema,
  DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
  DaemonLocalServicePublicPreviewStatusRequestV1Schema,
} from '../../local/services/public/v1.js';

const LOCAL_SERVICE_ACTION_BINDINGS = [
  ['localServices.actions.copyUrl', 'copy_url'],
  ['localServices.actions.openPreview', 'open_preview'],
  ['localServices.actions.forget', 'forget'],
  ['localServices.actions.stopManaged', 'stop_managed'],
  ['localServices.actions.restartManaged', 'restart_managed'],
  ['localServices.actions.terminateDetected', 'terminate_detected'],
] as const;

describe('local-services runtime Action specs', () => {
  it('advertises managed-service private preview operands while preserving the inventory target alias', () => {
    const request = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.parse({
      machineId: 'machine_1', serviceTarget: {
        kind: 'managed_service', managedServiceId: 'managed_1', machineId: 'machine_1', cwd: '/workspace/app',
        declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } },
      },
    });
    for (const id of ['localServices.preview.openOrCreate', 'localServices.preview.revoke'] as const) {
      const input = id === 'localServices.preview.revoke' ? { ...request, previewId: 'preview_1' } : request;
      for (const surface of ['agent', 'mcp'] as const) {
        const definition = getActionDefinitionForCatalogSurface({ id, surface });
        expect(definition, `${id} on ${surface}`).not.toBeNull();
        const published = definition!.inputSchema;
        expect(published.properties, `${id} on ${surface}`).toHaveProperty('serviceTarget');
        const validate = compileActionInputJsonSchema(published);
        expect(validate(input)).toBe(true);
        expect(validate({ ...input, serviceTarget: { kind: 'managed_service' } })).toBe(false);
        expect(parseLocalServiceDomainActionRpcRequest(id, getActionSpec(id).inputSchema.parse(input)))
          .toMatchObject({ success: true, data: input });
      }
    }
    const alias = getActionSpec('localServices.preview.openOrCreate').inputSchema.parse({
      machineId: 'machine_1', sessionId: 'session_1', targetId: 'inventory_1',
    });
    expect(parseLocalServiceDomainActionRpcRequest('localServices.preview.openOrCreate', alias))
      .toMatchObject({ success: true, data: { machineId: 'machine_1', sessionId: 'session_1', inventoryEntryId: 'inventory_1' } });
  });

  it('advertises canonical public-preview operands to agents and MCP without losing service bindings or consent', () => {
    const serviceTarget = {
      kind: 'managed_service', managedServiceId: 'managed_1', machineId: 'machine_1', cwd: '/workspace/app',
      declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } },
    };
    const binding = { machineId: 'machine_1', serviceTarget, previewId: 'preview_1' };
    const cases = [
      ['localServices.publicPreview.create', DaemonLocalServicePublicPreviewCreateRequestV1Schema,
        { ...binding, mode: 'secret_link', ttlMs: 60_000, rateLimitProfileId: 'default', confirmation: { acknowledged: true } }],
      ['localServices.publicPreview.revoke', DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
        { ...binding, exposureId: 'exposure_1' }],
      ['localServices.publicPreview.status', DaemonLocalServicePublicPreviewStatusRequestV1Schema, binding],
      ['localServices.publicPreview.copyUrl', DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
        { ...binding, exposureId: 'exposure_1' }],
    ] as const;

    for (const [id, wireSchema, input] of cases) {
      const request = wireSchema.parse(input);
      for (const surface of ['agent', 'mcp'] as const) {
        const definition = getActionDefinitionForCatalogSurface({ id, surface });
        expect(definition, `${id} on ${surface}`).not.toBeNull();
        const published = definition!.inputSchema;
        const wire = zodSchemaToJsonSchemaObject(wireSchema, { target: 'draft-7' });
        expect(Object.keys(published.properties ?? {}), `${id} on ${surface}`)
          .toEqual(expect.arrayContaining(Object.keys(wire.properties ?? {})));
        expect(published.required).toEqual(wire.required);
        const validate = compileActionInputJsonSchema(published);
        expect(validate(request), `${id} on ${surface}`).toBe(true);
        expect(validate({ ...request, serviceTarget: { kind: 'managed_service' } })).toBe(false);
        expect(getActionSpec(id).inputSchema.parse(request)).toEqual(request);
        if (id === 'localServices.publicPreview.create') {
          expect(validate({ ...request, confirmation: { acknowledged: false } })).toBe(false);
        }
      }
    }
  });

  it('binds every local-service Action id to exactly one request action', () => {
    const baseRequest = {
      requestId: 'request_1',
      target: {
        kind: 'managed_service' as const,
        managedServiceId: 'managed_1',
        machineId: 'machine_1',
      },
      confirmationNonce: 'confirmation_1',
      force: false,
    };

    for (const [index, [actionId, action]] of LOCAL_SERVICE_ACTION_BINDINGS.entries()) {
      const inputSchema = getActionSpec(actionId).inputSchema;
      const mismatchedAction = LOCAL_SERVICE_ACTION_BINDINGS[
        (index + 1) % LOCAL_SERVICE_ACTION_BINDINGS.length
      ][1];

      expect(inputSchema.safeParse({ ...baseRequest, action }).success, actionId).toBe(true);
      expect(
        inputSchema.safeParse({ ...baseRequest, action: mismatchedAction }).success,
        `${actionId} must reject ${mismatchedAction}`,
      ).toBe(false);
    }
  });
});
