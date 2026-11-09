import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '../manifest/ingest.js';
import { PluginContributesV2Schema } from './v2.js';
import { HealthCheckResultV1ProtocolSchema } from '../../deployments/healthCheckV1.js';
import { SavedHealthCheckSelectorV1ProtocolSchema } from '../../deployments/healthCheckSourceV1.js';

const configSchema = { type: 'object', properties: { expected: { type: 'string' } }, required: ['expected'], additionalProperties: false };
const kind = { id: 'external-health', title: 'External health', configSchema, action: 'observe-health' };
const action = { id: 'observe-health', title: 'Observe health', scopes: ['machine'], surfaces: ['plugin'],
    dangerLevel: 'safe', readOnly: true, execution: { target: 'daemon' },
    inputSchema: SavedHealthCheckSelectorV1ProtocolSchema.jsonSchema,
    resultSchema: HealthCheckResultV1ProtocolSchema.jsonSchema };
const manifest = (contributes: unknown) => ({ schemaVersion: 2, id: 'com.example.health', version: '1.0.0',
    displayName: 'External health', engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, contributes });

describe('healthCheckKinds canonical contribution admission', () => {
    it('admits an external finite Machine read with the canonical result and saved selector', () => {
        const result = ingestPluginManifestV2(manifest({ healthCheckKinds: [kind], actions: [action] }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(Reflect.get(result.manifest.contributes, 'healthCheckKinds')).toEqual([kind]);
    });

    it('admits a trusted finite daemon producer independently of its safety and read-only labels', () => {
        const { readOnly: _readOnly, ...withoutReadOnly } = action;
        for (const producer of [
            { ...action, dangerLevel: 'writesLocal', readOnly: false },
            withoutReadOnly,
        ]) {
            const result = ingestPluginManifestV2(manifest({ healthCheckKinds: [kind], actions: [producer] }));
            expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
            if (result.ok) expect(Reflect.get(result.manifest.contributes, 'healthCheckKinds')).toEqual([kind]);
        }
    });

    it('strict author admission rejects wrong-realm, tracked or noncanonical result Actions', () => {
        for (const invalid of [
            { ...action, execution: { target: 'client', client: { artifactId: 'client', exportName: 'activate' }, platforms: ['web'] } },
            { ...action, operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } } },
            { ...action, resultSchema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false } },
            { ...action, resultSchema: { ...action.resultSchema, additionalProperties: true } },
        ]) expect(PluginContributesV2Schema.safeParse({ healthCheckKinds: [kind], actions: [invalid] }).success).toBe(false);
        expect(PluginContributesV2Schema.safeParse({ healthCheckKinds: [kind], actions: [] }).success).toBe(false);
    });

    it('withdraws a bad sibling while retaining the valid kind and its Action', () => {
        const result = ingestPluginManifestV2(manifest({ actions: [action], healthCheckKinds: [
            { ...kind, id: 'bad-health', configSchema: { type: 'object', properties: { nested: { type: 'object' } }, additionalProperties: false } },
            kind,
            { ...kind, id: 'missing-health', action: 'missing' },
        ] }), { mode: 'load' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(Reflect.get(result.manifest.contributes, 'healthCheckKinds')).toEqual([kind]);
            expect(result.manifest.contributes.actions).toHaveLength(1);
            expect(result.diagnostics?.filter(item => item.code === 'plugin_contribution_skipped')).toHaveLength(2);
        }
    });
});
